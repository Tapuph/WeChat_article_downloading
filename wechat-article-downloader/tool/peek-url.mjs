// 仅用于探测文章标题/发布时间/正文长度（不下载图片），用于报告无法解析的文章
const urls = process.argv.slice(2);
for (const u of urls) {
  try {
    const res = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
    const html = await res.text();
    const pick = (re) => { const m = html.match(re); return m ? m[1].trim() : ''; };
    const title = pick(/property="og:title"\s+content="([^"]*)"/) || pick(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    const desc = pick(/property="og:description"\s+content="([^"]*)"/);
    const ts = pick(/var\s+ct\s*=\s*"(\d+)"/) || pick(/create_time\s*[:=]\s*"?(\d{10})/);
    const body = pick(/<div[^>]*id="js_content"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*id="js_sponsor"/);
    const bodyLen = body.replace(/<[^>]+>/g, '').replace(/\s+/g, '').length;
    const date = ts ? new Date(Number(ts) * 1000).toISOString().slice(0, 10) : '(无)';
    console.log(`URL: ${u}`);
    console.log(`  title=${title}`);
    console.log(`  date=${date}  ts=${ts || '-'}  htmlLen=${html.length}  bodyTextLen=${bodyLen}`);
    if (desc) console.log(`  desc=${desc.slice(0, 80)}`);
    const flat = html
      .replace(/<script[\s\S]*?<\/script>/g, ' ')
      .replace(/<style[\s\S]*?<\/style>/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    console.log(`  visible=${flat.slice(0, 200)}`);
  } catch (e) {
    console.log(`URL: ${u}\n  抓取失败: ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 800));
}
process.exit(0);
