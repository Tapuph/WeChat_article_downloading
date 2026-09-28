// 从内存扫描结果中，取目标公众号最近的 N 篇并下载。
// 判"最近"的依据：文章 URL 的 mid 单调递增（越新越大）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchArticle, normalizeUrl, sanitize } from './article.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BIZ = process.argv[2] || 'MzU1MTExMTE2NQ==';
const N = Number(process.argv[3] || 10);
const ACCOUNT = process.argv[4] || '牧之野';
// 可选 --out <目录>：指定输出根目录（默认 <包根>/out）
const outIdx = process.argv.indexOf('--out');
const OUT_ROOT_OVERRIDE = outIdx >= 0 ? process.argv[outIdx + 1] : null;
// 可选 --skip-existing：已下载过的（同 mid）不再下载
const SKIP_EXISTING = process.argv.includes('--skip-existing');

const urls = JSON.parse(fs.readFileSync(path.join(ROOT, 'work', 'urls.json'), 'utf8').replace(/^\uFEFF/, ''));
const hit = urls.articles.filter((a) => a.biz === BIZ);

// 规范化 + 去重 + 提取 mid
const seen = new Map();
for (const a of hit) {
  const u = normalizeUrl(a.url);
  const m = u.match(/[?&]mid=(\d+)/);
  if (!m) continue;
  const mid = Number(m[1]);
  if (!/sn=[a-f0-9]{32}/i.test(u) && !/[?&]chksm=[^&]{8,}/i.test(u)) continue; // 需要完整签名
  const cur = seen.get(mid);
  if (!cur || u.length > cur.length) seen.set(mid, u);
}

const outBase = OUT_ROOT_OVERRIDE ? path.resolve(OUT_ROOT_OVERRIDE) : path.join(ROOT, 'out');
const outDir = path.join(outBase, 'by_account', sanitize(ACCOUNT));

/** 收集该账号目录下"已下载过"的 mid：来自 HTML 的 wechat:mid 元信息与 _latest_*.json 清单。 */
function collectDownloadedMids(dir) {
  const mids = new Set();
  if (!fs.existsSync(dir)) return mids;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (f.endsWith('.html')) {
      try {
        const c = fs.readFileSync(p, 'utf8').slice(0, 6000); // meta 在头部
        const m = c.match(/<meta name="wechat:mid" content="([^"]*)"/);
        if (m && m[1]) mids.add(String(m[1]));
      } catch {}
    } else if (f.endsWith('.json')) {
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
        for (const a of (j.articles || [])) {
          const mm = String(a.url || '').match(/[?&]mid=(\d+)/);
          if (mm) mids.add(mm[1]);
        }
      } catch {}
    }
  }
  return mids;
}

const sorted = [...seen.entries()].sort((a, b) => b[0] - a[0]);

// 语义：先取"最新 N 篇"，再从中剔除已下载的；
// 不从更早的文章里回补（用户要的是"最新 N 篇"，不是"N 篇没下过的"）。
const topN = sorted.slice(0, N);
let picked = topN.map(([, u]) => u);
let skippedCount = 0;
if (SKIP_EXISTING) {
  const done = collectDownloadedMids(outDir);
  const keep = topN.filter(([mid]) => !done.has(String(mid)));
  skippedCount = topN.length - keep.length;
  picked = keep.map(([, u]) => u);
  console.log(`最新 ${topN.length} 篇中，已下载 ${skippedCount} 篇（跳过），本次待下载 ${picked.length} 篇`);
}

console.log(`${ACCOUNT} 候选 ${seen.size} 篇（含完整签名），本次下载 ${picked.length} 篇:`);
if (!picked.length) {
  console.log('  （最新 N 篇均已下载过，无需重复下载）');
}
picked.forEach((u, i) => {
  const mid = (u.match(/[?&]mid=(\d+)/) || [])[1];
  console.log(`  ${String(i + 1).padStart(2)}. mid=${mid}  ${u.slice(0, 100)}`);
});
console.log('');

fs.mkdirSync(outDir, { recursive: true });

let ok = 0;
const results = [];
for (let i = 0; i < picked.length; i++) {
  const u = picked[i];
  process.stdout.write(`[${i + 1}/${picked.length}] ${u.slice(0, 60)} … `);
  try {
    const res = await fetchArticle(u, outDir, { assetsDirName: 'assets', overwrite: true });
    const meta = res.meta;
    results.push({
      date: meta.publishTimeText, title: meta.title, account: meta.account,
      html: path.relative(ROOT, res.htmlPath),
      images: res.stats.downloaded, failedImages: res.stats.failed.length,
      url: u,
    });
    ok++;
    console.log(`OK  ${meta.publishTimeText}  ${(meta.title || '').slice(0, 36)}`);
  } catch (e) {
    results.push({ error: e.message, url: u });
    console.log(`FAIL  ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 1200));
}

results.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
fs.writeFileSync(
  path.join(outDir, `_latest_${sanitize(ACCOUNT)}.json`),
  JSON.stringify({ account: ACCOUNT, biz: BIZ, generatedAt: new Date().toISOString(), articles: results }, null, 2),
  'utf8',
);

console.log('');
console.log(`完成：成功 ${ok}/${picked.length}，输出 ${outDir}`);
console.log('汇总(按日期):');
results.forEach((r) => {
  if (r.error) console.log(`  ✗ ${r.error.slice(0, 50)}`);
  else console.log(`  ✓ ${r.date}  ${r.title}  (图${r.images})`);
});
