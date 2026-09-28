// 通过"内存中 biz 分布的变化"自动发现某个公众号的 __biz（无需公众平台凭证）。
//
// 用法:
//   node tool/discover-new-biz.mjs --baseline
//       记录当前内存中各 __biz 的文章数快照 -> work/biz-baseline.json
//   node tool/discover-new-biz.mjs --account "慕云思辨" --count 3
//       重新扫描内存，与快照对比，找出"新增最多"的 biz（即刚刚搜索/浏览的公众号），
//       打印结果，并直接下载它的最新 N 篇。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WORK = path.join(ROOT, 'work');
const URLS = path.join(WORK, 'urls.json');
const BASE = path.join(WORK, 'biz-baseline.json');

function scan() {
  execFileSync('powershell', ['-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'scan-wechat-urls.ps1'), '-OutDir', WORK], {
    stdio: 'ignore', timeout: 300000,
  });
  const j = JSON.parse(fs.readFileSync(URLS, 'utf8').replace(/^\uFEFF/, ''));
  const counts = {};
  for (const a of (j.articles || [])) {
    const b = a.biz || '(无biz)';
    counts[b] = (counts[b] || 0) + 1;
  }
  return counts;
}

function parseArgs(argv) {
  const o = { baseline: false, account: null, count: 3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--baseline') o.baseline = true;
    else if (a === '--account') o.account = argv[++i];
    else if (a === '--count') o.count = Number(argv[++i]);
  }
  return o;
}

const opts = parseArgs(process.argv.slice(2));

if (opts.baseline) {
  const counts = scan();
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(BASE, JSON.stringify({ at: new Date().toISOString(), counts }, null, 2), 'utf8');
  console.log(`已记录基线：${Object.keys(counts).length} 个 biz，共 ${Object.values(counts).reduce((a, b) => a + b, 0)} 篇 URL`);
  process.exit(0);
}

if (!opts.account) {
  console.error('用法: --baseline  或  --account <公众号名> [--count N]');
  process.exit(1);
}

const now = scan();
let before = { counts: {} };
try { before = JSON.parse(fs.readFileSync(BASE, 'utf8')); } catch {}

const deltas = [];
for (const [biz, n] of Object.entries(now)) {
  const was = before.counts[biz] || 0;
  const d = n - was;
  if (d > 0) deltas.push({ biz, now: n, was, delta: d });
}
deltas.sort((a, b) => b.delta - a.delta);

console.log(`扫描到 ${Object.keys(now).length} 个 biz`);
if (!deltas.length) {
  console.log('没有发现新增 biz（可能搜索/浏览未生效，或内存已被轮换）');
  process.exit(2);
}
console.log('新增最多的 biz:');
deltas.slice(0, 5).forEach((d) => console.log(`  ${d.biz}  新增 ${d.delta} 篇 (现有 ${d.now}，基线 ${d.was})`));

const target = deltas[0].biz;
console.log('');
console.log(`推定「${opts.account}」的 __biz = ${target}`);
fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(path.join(WORK, 'discovered-biz.json'),
  JSON.stringify({ account: opts.account, biz: target, delta: deltas[0].delta, at: new Date().toISOString() }, null, 2), 'utf8');

if (opts.count > 0) {
  console.log(`开始下载「${opts.account}」最新 ${opts.count} 篇 …`);
  const r = spawnSync('node', [
    path.join(__dirname, 'download-latest-biz.mjs'), target, String(opts.count), opts.account, '--skip-existing',
  ], { stdio: 'inherit' });
  process.exit(r.status ?? 0);
}
