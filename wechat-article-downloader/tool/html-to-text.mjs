// HTML → 纯文本/Markdown 整理工具。
// 从已下载的离线 HTML 提取：标题、作者、日期、原文链接、正文段落。
// 输出到 out/text/<账号>/ 下，并生成汇总索引。

// 用法:
//   node tool/html-to-text.mjs --account 原点时间          # 一个账号
//   node tool/html-to-text.mjs --account 原点时间 --format md
//   node tool/html-to-text.mjs --all --format txt           # 全部账号

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const IN_ROOT = path.join(ROOT, 'out', 'by_account');
const OUT_ROOT = path.join(ROOT, 'out', 'text');

function parseArgs(argv) {
  const o = { account: null, format: 'txt', all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--account') o.account = argv[++i];
    else if (a === '--format') o.format = argv[++i];
    else if (a === '--all') o.all = true;
  }
  return o;
}

const decode = (s) => String(s)
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

/** 从离线 HTML 提取结构化信息与纯文本正文。 */
function extract(html) {
  const meta = {
    title: decode((html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '').trim(),
    author: decode((html.match(/<meta name="author" content="([^"]*)"/) || [])[1] || '').trim(),
    date: decode((html.match(/<meta name="wechat:publish_time" content="([^"]*)"/) || [])[1] || '').trim(),
    source: decode((html.match(/<meta name="wechat:source" content="([^"]*)"/) || [])[1] || '').trim(),
  };
  let body = (html.match(/<div id="js_content">([\s\S]*?)<\/div>\s*<div class="offline-note">/) || [])[1] || '';
  if (!body) body = (html.match(/<div id="js_content">([\s\S]*)/) || [])[1] || '';

  // 图片占位（保留提示，方便知道哪里有图）
  body = body.replace(/<img\b[^>]*>/gi, '[图片]');
  // 块级标签换行
  body = body.replace(/<\/(p|div|section|h[1-6]|li|blockquote|tr|figcaption|table)>/gi, '\n');
  body = body.replace(/<(p|div|section|h[1-6]|li|blockquote|tr|figcaption|table)\b[^>]*>/gi, '\n');
  body = body.replace(/<br\s*\/?>/gi, '\n');
  // 去掉剩余标签
  body = body.replace(/<[^>]+>/g, '');
  body = decode(body);

  // 规整空白：行首尾去空格，连续空行合并成一个
  const lines = body.split(/\r?\n/).map((l) => l.replace(/[ \t]+/g, ' ').trim());
  const out = [];
  let blank = false;
  for (const l of lines) {
    if (!l) { if (!blank) { out.push(''); blank = true; } continue; }
    out.push(l); blank = false;
  }
  return { meta, text: out.join('\n').trim() };
}

function renderTxt({ meta, text }) {
  const head = [
    meta.title,
    '='.repeat(Math.min(meta.title.length, 40)),
    `作者: ${meta.author || '-'}   日期: ${meta.date || '-'}`,
    `原文: ${meta.source || '-'}`,
    '',
  ].join('\n');
  return head + text + '\n';
}

function renderMd({ meta, text }) {
  const head = [
    `# ${meta.title}`,
    '',
    `- 作者: ${meta.author || '-'}`,
    `- 日期: ${meta.date || '-'}`,
    `- 原文: ${meta.source || '-'}`,
    '',
    '---',
    '',
  ].join('\n');
  // 正文按空行分段，段内保留原换行
  const paras = text.split(/\n\n+/).map((p) => p.replace(/\n/g, '  \n').trim()).filter(Boolean);
  return head + paras.join('\n\n') + '\n';
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.account && !opts.all) {
  console.error('用法: node tool/html-to-text.mjs --account 公众号名 [--format txt|md]  或 --all');
  process.exit(1);
}

const targets = [];
if (opts.all) {
  for (const d of fs.readdirSync(IN_ROOT, { withFileTypes: true })) {
    if (d.isDirectory()) targets.push({ name: d.name, dir: path.join(IN_ROOT, d.name) });
  }
} else {
  const dir = path.join(IN_ROOT, opts.account);
  if (!fs.existsSync(dir)) { console.error('账号目录不存在:', dir); process.exit(1); }
  targets.push({ name: opts.account, dir });
}

let totalFiles = 0;
let totalChars = 0;

for (const t of targets) {
  const files = fs.readdirSync(t.dir).filter((f) => f.endsWith('.html'));
  if (!files.length) continue;
  const outDir = path.join(OUT_ROOT, t.name);
  fs.mkdirSync(outDir, { recursive: true });

  const index = [];
  for (const f of files) {
    const html = fs.readFileSync(path.join(t.dir, f), 'utf8');
    const { meta, text } = extract(html);
    if (!text) continue;
    const ext = opts.format === 'md' ? 'md' : 'txt';
    const outName = f.replace(/\.html$/, '.' + ext);
    const content = opts.format === 'md' ? renderMd({ meta, text }) : renderTxt({ meta, text });
    fs.writeFileSync(path.join(outDir, outName), content, 'utf8');
    index.push({ date: meta.date, title: meta.title, chars: text.length, file: outName });
    totalFiles++;
    totalChars += text.length;
  }

  index.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const idxLines = index.map((r, i) => `${String(i + 1).padStart(3)}. ${r.date}  ${r.title}  (${r.chars}字)`);
  fs.writeFileSync(path.join(outDir, '_目录.txt'), `「${t.name}」共 ${index.length} 篇\n\n` + idxLines.join('\n') + '\n', 'utf8');
  console.log(`「${t.name}」: ${index.length} 篇 → ${outDir}`);
}

console.log('');
console.log(`完成：共导出 ${totalFiles} 篇，正文合计 ${totalChars} 字，输出目录 ${OUT_ROOT}`);
