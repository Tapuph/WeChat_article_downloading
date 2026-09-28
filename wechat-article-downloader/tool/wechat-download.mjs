// 标准化流程：输入公众号名称 + 篇数，自动完成 打开微信 → 搜索 → 进主页 → 浏览 → 内存取 URL → 下载 → 校验。
//
// 用法:
//   node tool/wechat-download.mjs --account 牧之野 --count 10
//   node tool/wechat-download.mjs --account 原点时间 --count 10 --dry-run
//
// 设计原则（针对 OCR 不稳定问题）：
//   关键路径上不使用 OCR。控制信号全部是确定性的：
//     - 窗口强制最大化 → 固定坐标（最大化布局下标定）
//     - 每一步之后用"内存里该 __biz 的文章数"验证（count-biz 扫描）
//     - 点账号名失败自动回退（头像位置），必要时绿色像素定位
//   OCR 只作为诊断留档，不参与控制。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadCreds, searchAccount, SessionExpired } from './api.mjs';
import { sanitize } from './article.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WORK = path.join(ROOT, 'work');

function parseArgs(argv) {
  const o = { account: null, count: 10, dryRun: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--account') o.account = argv[++i];
    else if (a === '--count') o.count = Number(argv[++i]);
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--biz') o.biz = argv[++i];
    else if (a === '--skip-existing') o.skipExisting = true;
  }
  return o;
}

const log = (...m) => console.log('[流程]', ...m);

/** 优雅退出：等 undici keep-alive 连接空闲关闭，避免 process.exit 触发 Node 断言噪音。 */
async function quit(code) {
  await new Promise((r) => setTimeout(r, 4500));
  process.exit(code);
}

function runPs(script, args = []) {
  const r = spawnSync('powershell', ['-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, script), ...args.map(String)], {
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    throw new Error(`${script} 退出码 ${r.status}`);
  }
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.account) {
  console.error('用法: node tool/wechat-download.mjs --account 公众号名 --count 篇数 [--biz fakeid] [--out 输出目录] [--skip-existing] [--dry-run]');
  await quit(1);
}
const NAME = opts.account;
const COUNT = opts.count;

log(`目标: 「${NAME}」 下载最近 ${COUNT} 篇${opts.dryRun ? '（--dry-run 模式，跳过微信操作）' : ''}`);

// ---------- 阶段 A：定位公众号（平台接口，无 OCR） ----------
// 若已用 --biz 直接给出 fakeid，则跳过平台查询（凭证失效时也可用）
let fakeid = opts.biz || null;
if (fakeid) {
  log(`阶段 A：使用指定的 fakeid = ${fakeid}（跳过平台查询）`);
} else {
log('阶段 A：定位公众号 fakeid …');
try {
  const creds = loadCreds();
  const found = await searchAccount(creds, NAME, { onNotice: () => {} });
  const target = found.find((x) => x.nickname === NAME) || found[0];
  if (!target) throw new Error('搜不到该公众号');
  fakeid = target.fakeid;
  log(`  命中: ${target.nickname}  (fakeid=${fakeid}, 微信号=${target.alias || '-'})`);
  if (target.nickname !== NAME) log(`  注意: 没有同名精确匹配，使用最接近的「${target.nickname}」`);
} catch (e) {
  if (e instanceof SessionExpired) {
    console.error('平台凭证已过期。请运行: node tool/login.mjs （扫码登录公众平台）后重试；');
    console.error('或用 --biz <fakeid> 直接指定公众号，跳过平台查询。');
  } else {
    console.error('定位公众号失败:', e.message);
    console.error('可能原因：网络问题 / 公众平台凭证过期。');
  }
  await quit(2);
}
}   // 结束 else（平台查询分支）

if (opts.dryRun) {
  log('--dry-run：跳过微信 UI 步骤。假如此刻内存里已有该号 URL，可直接跑：');
  console.log(`  node tool/download-latest-biz.mjs "${fakeid}" ${COUNT} "${NAME}"`);
  await quit(0);
}

// ---------- 阶段 B：打开微信并确认登录 ----------
log('阶段 B：确保微信可见并已登录 …');
runPs('wx-ensure2.ps1', ['-Tag', 'flow-ensure']);
try {
  runPs('wx-wait-login.ps1', ['-TimeoutSec', '120']);
} catch (e) {
  console.error('微信似乎需要扫码登录。我已把登录窗口置前，请用手机扫码，然后重新运行本命令（支持断点续跑，已下载的会跳过）。');
  await quit(3);
}
runPs('wx-front2.ps1', ['-Tag', 'flow-front']);

// ---------- 阶段 C：搜索 → 进主页 → 滚动浏览（确定性 UI 驱动） ----------
log('阶段 C：搜索并浏览文章（内存加载中） …');
runPs('wx-search-det.ps1', ['-Keyword', NAME, '-Biz', fakeid, '-TargetCount', String(COUNT)]);

const statusPath = path.join(WORK, 'last-ui-status.json');
let status = { ok: false };
try {
  status = JSON.parse(fs.readFileSync(statusPath, 'utf8').replace(/^\uFEFF/, ''));
} catch {}
if (!status.ok) {
  console.error('UI 阶段失败:', status.message);
  console.error('诊断截图在 work/ 下（以 flow- 或最新时间戳命名），可发给我排查。');
  await quit(4);
}
log(`  内存中该号文章 ${status.memoryCount} 篇`);

// ---------- 阶段 D：扫描内存取 URL ----------
log('阶段 D：扫描内存提取 URL …');
runPs('scan-wechat-urls.ps1');

// ---------- 阶段 E：下载最近 N 篇 ----------
log(`阶段 E：下载最近 ${COUNT} 篇${opts.out ? ` → ${opts.out}` : ''} …`);
const dlArgs = [path.join(__dirname, 'download-latest-biz.mjs'), fakeid, String(COUNT), NAME];
if (opts.out) dlArgs.push('--out', opts.out);
if (opts.skipExisting) dlArgs.push('--skip-existing');
const dl = spawnSync('node', dlArgs, { stdio: 'inherit' });
if (dl.status !== 0) {
  console.error('下载阶段失败，退出码', dl.status);
  await quit(5);
}

// ---------- 阶段 F：校验 ----------
log('阶段 F：校验 …');
const outBase = opts.out ? path.resolve(opts.out) : path.join(ROOT, 'out');
const outDir = path.join(outBase, 'by_account', sanitize(NAME));
const htmls = fs.readdirSync(outDir).filter((f) => f.endsWith('.html'));
let bad = 0;
for (const f of htmls) {
  const c = fs.readFileSync(path.join(outDir, f), 'utf8');
  const inner = (c.match(/<div id="js_content">([\s\S]*?)<\/div>\s*<div class="offline-note">/) || [])[1] || '';
  const imgs = inner.match(/<img\b[^>]*>/gi) || [];
  const noSrc = imgs.filter((t) => !/(?<![\w-])src\s*=/.test(t)).length;
  const remote = imgs.filter((t) => /\bsrc\s*=\s*["']https?:/.test(t)).length;
  if (noSrc > 0 || remote > 0) { bad++; log(`  ⚠ ${f}: 无src=${noSrc} 外链=${remote}`); }
}
log(`  校验完成: ${htmls.length} 篇 HTML${bad ? `，${bad} 篇有图片引用问题` : '，图片全部本地化 ✓'}`);
log(`  输出目录: ${outDir}`);
log('完成。');
