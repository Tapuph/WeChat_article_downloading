// 打开微信公众平台后台，等你扫码登录，然后自动抓取 cookie + token 存到 creds.json。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchEdge, waitForPage, CDP, sleep } from './cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CREDS = path.join(ROOT, 'creds.json');
const USER_DATA = path.join(ROOT, '.edge-profile');
const PORT = 9333;
const HOME = 'https://mp.weixin.qq.com/';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[k] = v;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const timeoutSec = Number(args.timeout || 600);

console.log('[1/4] 启动 Edge（独立用户目录 .edge-profile，不影响你日常浏览器）…');
launchEdge({ port: PORT, userDataDir: USER_DATA, url: HOME });
await sleep(1500);

console.log('[2/4] 连接调试端口…');
const target = await waitForPage(PORT, { tries: 40 });
const cdp = await new CDP(target.webSocketDebuggerUrl).connect();
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Network.enable');

console.log('');
console.log('=========================================================');
console.log('  请在弹出的 Edge 窗口里扫码登录微信公众平台后台。');
console.log('  登录成功、看到后台首页后不用做任何操作，我会自动检测。');
console.log(`  等待上限：${timeoutSec} 秒`);
console.log('=========================================================');
console.log('');

const deadline = Date.now() + timeoutSec * 1000;
let token = null;
let lastNote = 0;

while (Date.now() < deadline) {
  const state = await cdp.evaluate(`(() => {
    const href = location.href;
    let tok = null;
    try {
      const sp = new URLSearchParams(location.search);
      tok = sp.get('token');
    } catch (e) {}
    return { href, token: tok, title: document.title };
  })()`).catch(() => null);

  if (state) {
    token = state.token || (state.href.match(/[?&]token=(\d+)/) || [])[1] || null;
    if (token) {
      console.log(`  已登录！token = ${token}`);
      break;
    }
    if (Date.now() - lastNote > 20000) {
      lastNote = Date.now();
      console.log(`  …等待登录中（当前页面：${String(state.title).slice(0, 40)}）`);
    }
  }
  await sleep(1500);
}

if (!token) {
  console.error('\n[失败] 超时仍未检测到登录态。请重新运行：node tool/login.mjs');
  cdp.close();
  process.exit(2);
}

console.log('[3/4] 抓取 cookie…');
const cookies = await cdp.cookies('https://mp.weixin.qq.com');
const slaveSid = cookies.find((c) => c.name === 'slave_sid');
const dataTicket = cookies.find((c) => c.name === 'data_ticket');
if (!slaveSid || !dataTicket) {
  console.error('[警告] 缺少 slave_sid / data_ticket，可能没登录完全。已拿到的 cookie：',
    cookies.map((c) => c.name).join(', '));
}

const creds = {
  token,
  createdAt: new Date().toISOString(),
  cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
  cookies: cookies.map(({ name, value, domain, path: p, expires }) => ({ name, value, domain, path: p, expires })),
};

fs.writeFileSync(CREDS, JSON.stringify(creds, null, 2), 'utf8');

console.log('[4/4] 完成。凭证已保存到：');
console.log('  ' + CREDS);
console.log(`  token=${token}, cookie 共 ${cookies.length} 项`);
console.log('');
console.log('这个 cookie 通常几小时后失效。如果后面报 "invalid session"，重新跑一次本命令即可。');
console.log('Edge 窗口可以关掉了。');
cdp.close();
process.exit(0);
