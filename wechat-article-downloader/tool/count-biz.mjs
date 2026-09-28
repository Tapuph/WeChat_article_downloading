// 快速统计微信内存里指定 __biz 的文章 URL 数量。
// 失败时打印明确原因（此前静默崩溃导致上层只看到 -1，无法定位）。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const biz = process.argv[2] || 'Mzg4MzY5NzE3MQ==';
const outDir = path.join(ROOT, 'work', 'probe');
const jsonPath = path.join(outDir, 'urls.json');

// 复用扫描脚本（它内部已做候选择优）。扫描失败会抛错，这里捕获并给出明确信息。
try {
  execFileSync(
    'powershell',
    ['-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'scan-wechat-urls.ps1'), '-OutDir', outDir],
    { stdio: 'ignore', timeout: 180000 },
  );
} catch (e) {
  console.error(`SCAN_ERROR: ${e.message}`);
  console.error(`  脚本: ${path.join(__dirname, 'scan-wechat-urls.ps1')}`);
  process.exit(1);
}

if (!fs.existsSync(jsonPath)) {
  console.error(`SCAN_ERROR: 扫描未产出 ${jsonPath}（可能微信未运行或扫描脚本内部失败）`);
  process.exit(1);
}

let j;
try {
  j = JSON.parse(fs.readFileSync(jsonPath, 'utf8').replace(/^\uFEFF/, ''));
} catch (e) {
  console.error(`JSON_ERROR: ${e.message}  (${jsonPath})`);
  process.exit(1);
}

const hits = (j.articles || []).filter((a) => a.biz === biz);
console.log(`总链接 ${j.articles.length} 条；__biz=${biz} 命中 ${hits.length} 篇`);
// 机器可读标记（纯 ASCII）：PowerShell 5.1 默认 GBK 控制台会把中文输出变乱码，
// 上层脚本依赖此 ASCII 行解析计数，避免编码问题。
console.log(`RESULT_COUNT=${hits.length}`);
hits.slice(0, 20).forEach((h) => console.log('  ' + h.url.slice(0, 130)));
