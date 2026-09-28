// 下载单篇公众号文章：保存 HTML + 把图片/音频下载到独立 assets 文件夹并改写引用。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export function sanitize(name, fallback = 'untitled') {
  const s = String(name || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  return (s || fallback).slice(0, 100);
}

const decodeEntities = (s) =>
  String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');

function pick(html, re) {
  const m = html.match(re);
  return m ? decodeEntities(m[1]).trim() : '';
}

/**
 * 从整页 HTML 中精确提取 <div id="js_content"> 的完整内容（含嵌套 div）。
 *
 * 为什么不能只用正则：js_content 内部有大量嵌套 <div>/<section>，
 * 正则无法配对任意深度的嵌套，之前用"遇到下一个 id=js_tags/profile 就停"
 * 的假设在部分文章上不成立，导致正文被判为空（整篇下载失败）。
 */
export function extractJsContent(html) {
  const openRe = /<div\b[^>]*\bid\s*=\s*["']js_content["'][^>]*>/gi;
  const m = openRe.exec(html);
  if (!m) return '';
  let i = m.index + m[0].length;

  // 自闭合/空元素（无结束标签），避免它们干扰配对计数
  const voidTags = new Set([
    'br', 'img', 'input', 'hr', 'meta', 'link', 'source', 'track', 'area', 'base', 'col', 'embed', 'param', 'wbr',
  ]);
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
  tagRe.lastIndex = i;
  let depth = 1;
  let t;
  while ((t = tagRe.exec(html)) !== null) {
    const closing = t[1] === '/';
    const name = t[2].toLowerCase();
    const attrs = t[3] || '';
    if (voidTags.has(name) || attrs.trimEnd().endsWith('/')) continue;
    if (name !== 'div') continue; // 只配对 div，section/p/span 不影响与 js_content 的配对
    if (closing) {
      depth--;
      if (depth === 0) {
        let body = html.slice(i, t.index);
        // 去掉微信的懒加载占位脚本
        body = body.replace(/<script[\s\S]*?<\/script>/gi, '');
        return body;
      }
    } else {
      depth++;
    }
  }
  // 没有配对的结束标签：退化为取到页尾，并尽量在 </body> 前截断
  let body = html.slice(i);
  const cut = body.search(/<script\b|<div[^>]*id="js_(tags|profile|reward|praise)/i);
  if (cut > 200) body = body.slice(0, cut);
  return body.replace(/<script[\s\S]*?<\/script>/gi, '');
}

/**
 * 新版文章模板（无 js_content 容器）的正文提取。
 *
 * 这类页面把文章数据塞在一个内嵌 JS 对象字面量里，例如：
 *   { ..., content: '...', content_noencode: '正文\x0a\x0a第二段', create_time: '2026-05-12 11:30', ... }
 * 其中 \x0a 表示换行，\x26amp; 之类是二次转义的 HTML 实体。
 */
export function extractEmbeddedContent(html) {
  const m = html.match(/\bcontent_noencode\s*:\s*'([\s\S]*?)'\s*,\s*(?:\w+\s*:)/);
  if (!m) return '';
  let s = m[1];

  // 还原转义：先 \\ 再 \x0a / \uXXXX，顺序不能颠倒
  s = s
    .replace(/\\\\/g, '\u0000ESC\u0000')
    .replace(/\\x0a/gi, '\n')
    .replace(/\\x0d/gi, '\r')
    .replace(/\\n/g, '\n')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_a, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\u0000ESC\u0000/g, '\\');

  // 二次转义的实体（页面源码里是 \x26amp; → &amp;）
  s = s.replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');

  // 转成 HTML：空行分段，单换行用 <br>
  const blocks = s.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const body = blocks
    .map((b) => `<p style="margin:0 0 16px;line-height:1.75;">${escapeHtml(b).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
  return body;
}

/** 从内嵌 JS 数据里取一个字段值（处理单/双引号与转义，且要求字段名有明确左边界）。 */
function pickEmbedded(html, field) {
  // 左边界用 (?<![\w-]) 而非 \b：避免把 data-miniprogram-nickname 误当成 nickname
  const re = new RegExp(`(?<![\\w-])${field}\\s*:\\s*(?:'((?:[^'\\\\]|\\\\.)*)'|"((?:[^"\\\\]|\\\\.)*)")`);
  const m = html.match(re);
  if (!m) return '';
  const raw = m[1] ?? m[2] ?? '';
  return raw
    .replace(/\\x0a/gi, '\n')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_a, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/** 从文章页 HTML 里抽取元信息与正文。 */
export function parseArticle(html) {
  const meta = {
    // 注意：真实页面里 var msg_title 只在 JS 中以 window.msg_title 出现，
    // 直接匹配 var msg_title 会跨语句吞掉后续脚本（曾导致标题串行）。
    // og:title 是最干净可靠的来源，htmlDecode("...") 为兜底。
    title:
      pick(html, /<meta\s+property="og:title"\s+content="([^"]*)"/i) ||
      pick(html, /var\s+msg_title\s*=\s*htmlDecode\(\s*["']([^"'\n]{1,300})["']\s*\)/) ||
      pick(html, /<h1[^>]*id="activity-name"[^>]*>([^<]{1,300})<\/h1>/i),
    author:
      pick(html, /var\s+nickname\s*=\s*htmlDecode\(\s*["']([^"'\n]{1,120})["']\s*\)/) ||
      pick(html, /var\s+nickname\s*=\s*["']([^"'\n]{1,120})["']/) ||
      pick(html, /<a[^>]*id="js_name"[^>]*>([^<]{1,120})<\/a>/i),
    account:
      pick(html, /var\s+nickname\s*=\s*htmlDecode\(\s*["']([^"'\n]{1,120})["']\s*\)/) ||
      pick(html, /var\s+nickname\s*=\s*["']([^"'\n]{1,120})["']/),
    publishTime:
      pick(html, /var\s+ct\s*=\s*["'](\d{9,})["']/) ||
      pick(html, /var\s+create_time\s*=\s*["'](\d{9,})["']/),
    cover:
      pick(html, /var\s+msg_cdn_url\s*=\s*["']([^"'\n]{1,500})["']/) ||
      pick(html, /<meta\s+property="og:image"\s+content="([^"]*)"/i),
    biz: pick(html, /var\s+biz\s*=\s*["']([^"'\n]{1,40})["']/) || pick(html, /__biz=([A-Za-z0-9=+/]+)/),
    mid: pick(html, /var\s+mid\s*=\s*["']?(\d{1,25})/) || pick(html, /[?&]mid=(\d{1,25})/),
    idx: pick(html, /var\s+idx\s*=\s*["']?(\d{1,10})/) || pick(html, /[?&]idx=(\d{1,10})/),
    sn: pick(html, /var\s+sn\s*=\s*["']([a-f0-9]{1,64})["']/) || pick(html, /[?&]sn=([a-f0-9]{1,64})/),
  };
  if (meta.publishTime && /^\d{9,}$/.test(meta.publishTime)) {
    const d = new Date(Number(meta.publishTime) * 1000);
    meta.publishTimeText = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  } else {
    meta.publishTimeText = (meta.publishTime || '').replace(/[^\d-]/g, '').slice(0, 10);
  }

  let rawContent = extractJsContent(html);
  if (!rawContent || rawContent.length < 200) {
    // 新版模板没有 js_content 容器，改用内嵌 JS 数据里的 content_noencode
    const embedded = extractEmbeddedContent(html);
    if (embedded.length > (rawContent || '').length) {
      rawContent = embedded;
      meta.template = 'embedded';
    }
  }
  if (!meta.template) meta.template = 'js_content';

  // 新版模板的补充元信息（仅在这些字段为空时回填）
  // 注意字段名差异：常规模板用 nickname，新版 JS 数据用 nick_name
  const embNick = pickEmbedded(html, 'nick_name');
  // 排除误匹配到属性名的情况（如 data-miniprogram-nickname 的值）
  const safeNick = embNick && !/^(data-|mp-|js-)/.test(embNick) && embNick.length <= 60 ? embNick : '';
  if (!meta.author) meta.author = safeNick;
  if (!meta.account) meta.account = safeNick;
  if (!meta.biz) meta.biz = pickEmbedded(html, 'biz') || pickEmbedded(html, 'user_name');
  if (!meta.cover) meta.cover = pickEmbedded(html, 'cdn_url_1_1') || pickEmbedded(html, 'cdn_url');
  if (!meta.publishTimeText) {
    const ct = pickEmbedded(html, 'create_time');
    if (ct) meta.publishTimeText = ct.slice(0, 10);
  }

  meta.contentHtml = rawContent;
  meta.contentLength = (rawContent || '').length;
  return meta;
}

function extFromUrl(u, fallback = '.jpg') {
  const clean = u.split('?')[0].split('#')[0];
  const m = clean.match(/\.(png|jpe?g|gif|webp|bmp|svg|mp3|m4a|mp4|amr|wav)$/i);
  if (m) return '.' + m[1].toLowerCase().replace('jpeg', 'jpg');
  if (/wx_fmt=(\w+)/.test(u)) {
    const f = u.match(/wx_fmt=(\w+)/)[1].toLowerCase();
    return '.' + (f === 'jpeg' ? 'jpg' : f);
  }
  return fallback;
}

function hashName(url, ext) {
  return crypto.createHash('sha1').update(url).digest('hex').slice(0, 16) + ext;
}

/** 按文件头修正扩展名：URL 常无扩展名，若一律存成 .jpg 而实为 PNG 会损坏图片。 */
function sniffExt(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return '.gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return '.webp';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return '.bmp';
  return null;
}

/** 下载 url 到 destDir，返回相对文件名；失败返回 null。 */
async function downloadAsset(url, destDir, referer, stats) {
  const ext = extFromUrl(url);
  let fname = hashName(url, ext);
  let dest = path.join(destDir, fname);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    stats.reused++;
    return fname;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: referer },
        redirect: 'follow',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length === 0) throw new Error('空响应');

      // 用真实文件头校正扩展名，避免把 PNG 存成 .jpg
      const real = sniffExt(buf);
      if (real && real !== ext) {
        fname = hashName(url, real);
        dest = path.join(destDir, fname);
      }
      fs.writeFileSync(dest, buf);
      stats.downloaded++;
      return fname;
    } catch (e) {
      if (attempt === 2) {
        stats.failed.push({ url, error: e.message });
        return null;
      }
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  return null;
}

/** 生成一张离线友好的 HTML 文档（保留原排版，引用本地 assets）。 */
function buildDocument({ meta, bodyHtml, assetsDirName }) {
  const title = meta.title || '未命名文章';
  const cover = meta.coverLocal ? `<meta property="og:image" content="${assetsDirName}/${meta.coverLocal}">` : '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="author" content="${escapeHtml(meta.author || '')}">
<meta name="description" content="${escapeHtml(meta.account || '')}">
${cover}
<meta name="wechat:source" content="${escapeHtml(meta.sourceUrl || '')}">
<meta name="wechat:biz" content="${escapeHtml(meta.biz || '')}">
<meta name="wechat:mid" content="${escapeHtml(meta.mid || '')}">
<meta name="wechat:idx" content="${escapeHtml(meta.idx || '')}">
<meta name="wechat:publish_time" content="${escapeHtml(meta.publishTimeText || '')}">
<style>
  :root { color-scheme: light; }
  body { margin:0; background:#ededed; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif; }
  .wrap { max-width:677px; margin:0 auto; background:#fff; padding:20px 16px 40px; }
  .art-head { border-bottom:1px solid #eee; padding-bottom:16px; margin-bottom:20px; }
  .art-head h1 { font-size:22px; line-height:1.4; margin:0 0 12px; }
  .art-meta { font-size:13px; color:#8c8c8c; line-height:1.8; }
  .art-meta a { color:#576b95; text-decoration:none; }
  #js_content { font-size:17px; line-height:1.75; color:#333; word-break:break-word; }
  #js_content img { max-width:100% !important; height:auto !important; display:block; margin:8px auto; }
  #js_content section, #js_content p { max-width:100%; }
  #js_content a { color:#576b95; }
  #js_content mpvoice, #js_content mp-common-mpaudio { display:block; margin:12px 0; }
  #js_content blockquote { border-left:3px solid #ddd; margin:12px 0; padding-left:12px; color:#666; }
  #js_content table { border-collapse:collapse; max-width:100%; }
  #js_content td, #js_content th { border:1px solid #ddd; padding:4px 8px; }
  .offline-note { margin-top:28px; padding-top:14px; border-top:1px solid #eee; font-size:12px; color:#aaa; }
</style>
</head>
<body>
<div class="wrap">
  <div class="art-head">
    <h1>${escapeHtml(title)}</h1>
    <div class="art-meta">
      ${meta.author ? `<span>${escapeHtml(meta.author)}</span>` : ''}
      ${meta.publishTimeText ? ` &middot; <span>${escapeHtml(meta.publishTimeText)}</span>` : ''}
      ${meta.sourceUrl ? `<br><a href="${escapeHtml(meta.sourceUrl)}">原文链接</a>` : ''}
    </div>
  </div>
  <div id="js_content">
${bodyHtml}
  </div>
  <div class="offline-note">离线存档 · 抓取时间 ${new Date().toISOString().slice(0, 19).replace('T', ' ')} · 图片位于 ${assetsDirName}/</div>
</div>
</body>
</html>
`;
}

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 清理链接：只做最小改动（补协议、解码 HTML 实体、去首尾空白），绝不裁剪查询参数。 */
export function normalizeUrl(u) {
  if (!u) return u;
  let s = String(u).trim();
  // 内存里可能混入 &amp; / &#38; 等实体（甚至多重转义），循环解到稳定为止
  for (let i = 0; i < 5; i++) {
    const before = s;
    s = s
      .replace(/&amp;/gi, '&')
      .replace(/&#0*38;/g, '&')
      .replace(/&#x0*26;/gi, '&');
    if (s === before) break;
  }
  if (/^mp\.weixin\.qq\.com\//i.test(s)) s = 'https://' + s;
  return s;
}

/** 判断链接形态，便于回报问题。 */
export function urlKind(u) {
  if (/mp\.weixin\.qq\.com\/s\/[A-Za-z0-9_-]+/.test(u)) return 'short';
  if (/mp\.weixin\.qq\.com\/s\?/.test(u)) return 'legacy';
  return 'unknown';
}

/** 主流程：抓取 + 本地化 + 落盘。 */
export async function fetchArticle(rawUrl, outDir, opts = {}) {
  const url = normalizeUrl(rawUrl);
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: 'https://mp.weixin.qq.com/',
    },
    redirect: 'follow',
  });
  const html = await r.text();
  if (r.status !== 200) throw new Error(`文章页 HTTP ${r.status}`);
  if (/环境异常|去验证|操作频繁/.test(html)) throw new Error('触发风控验证页（环境异常/去验证）');
  if (/该内容已被发布者删除|此内容因违规无法查看/.test(html)) throw new Error('文章已被删除或违规');

  const meta = parseArticle(html);
  if (!meta.contentHtml || meta.contentHtml.length < 40) throw new Error('未解析到正文（js_content 为空）');

  const stats = { downloaded: 0, reused: 0, failed: [] };
  const assetsDirName = opts.assetsDirName || 'assets';
  const destDir = path.join(outDir, assetsDirName);

  // 收集并本地化 body 中的资源引用。
  // 微信图片的坑：
  //   - 用 data-src 懒加载，很多 <img> 根本没有 src 属性；
  //   - 也有 src 存在但指向别的占位图；
  //   - 还有 src="//res.wx.qq.com/..." 这种协议相对地址。
  // 浏览器只认 src，所以必须保证“每张图最终都有指向本地文件的 src”。
  let body = meta.contentHtml;
  const urls = new Set();
  const toAbs = (u) => {
    const s = u.trim();
    if (!s || /^data:/i.test(s)) return '';
    if (/^https?:\/\//i.test(s)) return s;
    if (s.startsWith('//')) return 'https:' + s;
    if (/^mmbiz\.qpic\.cn\//i.test(s)) return 'https://' + s;
    if (s.startsWith('/')) return 'https://mp.weixin.qq.com' + s;
    return '';
  };
  const attrRe = /\b(data-src|src)\s*=\s*("([^"]*)"|'([^']*)')/gi;
  for (const m of body.matchAll(attrRe)) {
    const abs = toAbs(m[3] ?? m[4] ?? '');
    if (abs) urls.add(abs);
  }
  for (const m of body.matchAll(/<(?:mpvoice|mp-common-mpaudio)[^>]*?(?:voice_encode_fileid|data-voiceid)\s*=\s*["']([^"']+)["']/gi)) {
    urls.add(`https://res.wx.qq.com/voice/getvoice?mediaid=${m[1]}`);
  }

  /**
   * 把 body 中某个远端 URL 的所有引用替换为本地相对路径。
   * - 同时覆盖 data-src 与 src（单双引号皆可）；
   * - 若该 URL 原本只在 data-src 上、src 缺失，则补一个 src，保证浏览器能渲染。
   */
  function localizeRefs(html, remoteUrl, localPath, destDir, assetsDirName) {
    const esc = remoteUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const variants = [remoteUrl];
    if (remoteUrl.startsWith('https://')) variants.push(remoteUrl.slice(6)); // 协议相对形式

    let out = html;
    let replaced = 0;
    let used = localPath;
    for (const v of variants) {
      const escV = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\b(data-src|src)(\\s*=\\s*)(["'])${escV}\\3`, 'gi');
      out = out.replace(re, (all, attr, eq, q) => {
        // 优先使用目录里真实存在的文件（历史版本可能存成了别的扩展名）
        if (replaced === 0) used = resolveExisting(destDir, assetsDirName, path.basename(localPath), all);
        replaced++;
        return `${attr}${eq}${q}${used}${q}`;
      });
    }
    if (replaced === 0) return out;
    void esc;

    // 处理"只有 data-src、没有 src"的 <img>：补上 src
    const escUsed = used.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(/<img\b[^>]*>/gi, (tag) => {
      // 注意：必须用 (?<![\w-]) 排除 data-src —— \bsrc\s*= 会把 data-src 误当 src
      if (/(?<![\w-])src\s*=/i.test(tag)) return tag;
      if (!new RegExp(`\\bdata-src\\s*=\\s*["']${escUsed}["']`, 'i').test(tag)) return tag;
      return tag.replace(/\s*\/?>$/, (tail) => ` src="${used}"${tail}`);
    });
    return out;
  }

  /** 若存在同名不同扩展名的文件，返回实际存在的那一个。 */
  function resolveExisting(destDir, assetsDirName, wantBase, originalTag) {
    const want = path.join(destDir, wantBase);
    if (fs.existsSync(want)) return `${assetsDirName}/${wantBase}`;
    const stem = wantBase.replace(/\.[^.]+$/, '');
    for (const alt of ['.png', '.jpg', '.gif', '.webp', '.bmp']) {
      const cand = stem + alt;
      if (fs.existsSync(path.join(destDir, cand))) return `${assetsDirName}/${cand}`;
    }
    void originalTag;
    return `${assetsDirName}/${wantBase}`;
  }

  if (urls.size) {
    fs.mkdirSync(destDir, { recursive: true });
    const list = [...urls];
    const CONC = opts.concurrency || 4;
    for (let i = 0; i < list.length; i += CONC) {
      const batch = list.slice(i, i + CONC);
      const results = await Promise.all(batch.map((u) => downloadAsset(u, destDir, url, stats)));
      batch.forEach((u, k) => {
        const fname = results[k];
        if (!fname) return;
        body = localizeRefs(body, u, `${assetsDirName}/${fname}`, destDir, assetsDirName);
      });
    }
  }

  // 兜底：凡 data-src 已指向本地资源但缺 src 的 <img>，一律补上 src。
  // 场景：上一轮版本只改了 data-src（未补 src），此时该 URL 已不是远端地址，
  // 上面的替换流程不会触发，必须在最后统一修补。浏览器只认 src，不补就显示不出图。
  body = body.replace(/<img\b[^>]*>/gi, (tag) => {
    // 关键：用 (?<![\w-]) 排除 data-src。\bsrc\s*= 会把 data-src= 误判成已有 src，
    // 导致兜底从不生效（此前所有图片不显示的根因）。
    if (/(?<![\w-])src\s*=/i.test(tag)) return tag;
    const m = tag.match(/\bdata-src\s*=\s*["']([^"']+)["']/i);
    if (!m) return tag;
    const val = m[1];
    const isLocal = new RegExp(`^${assetsDirName}/`).test(val);
    if (!isLocal) return tag;
    return tag.replace(/\s*\/?>$/, (tail) => ` src="${val}"${tail}`);
  });

  // 清理微信生成的无用空占位：<img class="rich_pages wxw-img" />（无 src 也无 data-src，
  // 紧跟在真实图片后面，不渲染任何内容）。
  body = body.replace(/<img\b(?![^>]*\b(?:src|data-src)\s*=)[^>]*\/?>/gi, '');

  // 封面
  if (meta.cover) {
    fs.mkdirSync(destDir, { recursive: true });
    const cf = await downloadAsset(meta.cover, destDir, url, stats);
    if (cf) meta.coverLocal = cf;
  }

  // 长度截断，避免极端长文写爆
  if (body.length > 6_000_000) body = body.slice(0, 6_000_000);

  fs.mkdirSync(outDir, { recursive: true });
  const doc = buildDocument({
    meta: { ...meta, sourceUrl: url },
    bodyHtml: body,
    assetsDirName,
  });
  const base = sanitize(`${meta.publishTimeText ? meta.publishTimeText + '_' : ''}${meta.title}`);
  let htmlPath = path.join(outDir, base + '.html');
  let n = 1;
  while (fs.existsSync(htmlPath) && !opts.overwrite) {
    htmlPath = path.join(outDir, `${base}(${n++}).html`);
  }
  fs.writeFileSync(htmlPath, doc, 'utf8');

  return { htmlPath, meta, stats, base };
}
