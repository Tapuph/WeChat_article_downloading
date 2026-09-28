// 极简 Chrome DevTools Protocol 客户端：只用 Node 24 内置 WebSocket，零依赖。
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

export function findEdge() {
  for (const p of EDGE_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('找不到 msedge.exe');
}

/** 启动一个带调试端口的 Edge 实例（独立用户目录，不影响你日常浏览器）。 */
export function launchEdge({ port, userDataDir, url, headless = false }) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const exe = findEdge();
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=msEdgeSidebarV2',
    '--remote-allow-origins=*',
  ];
  if (headless) args.push('--headless=new');
  args.push(url);
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

async function fetchJson(url, tries = 60, gap = 500) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
      last = new Error(`HTTP ${r.status}`);
    } catch (e) {
      last = e;
    }
    await sleep(gap);
  }
  throw new Error(`CDP 端口连不上: ${last?.message}`);
}

/** 等待调试端口就绪，返回 page 类型的 target。 */
export async function waitForPage(port, { urlIncludes = null, tries = 60 } = {}) {
  for (let i = 0; i < tries; i++) {
    const list = await fetchJson(`http://127.0.0.1:${port}/json/list`, 3, 400).catch(() => []);
    const pages = (list || []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    const hit = urlIncludes ? pages.find((t) => (t.url || '').includes(urlIncludes)) : pages[0];
    if (hit) return hit;
    await sleep(500);
  }
  throw new Error('没有找到可用的 page target');
}

export class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.ws = null;
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const to = setTimeout(() => reject(new Error('WebSocket 连接超时')), 15000);
      ws.addEventListener('open', () => { clearTimeout(to); resolve(); });
      ws.addEventListener('error', (e) => { clearTimeout(to); reject(new Error('WebSocket 错误: ' + (e?.message || 'unknown'))); });
      ws.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
        if (msg.id != null && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)));
          else res(msg.result);
        } else if (msg.method) {
          const hs = this.handlers.get(msg.method);
          if (hs) for (const h of hs) { try { h(msg.params); } catch {} }
        }
      });
    });
    return this;
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(to); resolve(v); },
        reject: (e) => { clearTimeout(to); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** 在页面里执行表达式并取回 JSON 结果。 */
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error('页面执行异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result?.value;
  }

  async cookies(url) {
    const r = await this.send('Network.getCookies', url ? { urls: [url] } : {});
    return r.cookies || [];
  }

  async navigate(url) {
    await this.send('Page.navigate', { url });
  }

  close() {
    try { this.ws?.close(); } catch {}
  }
}

export function cookieHeader(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

export { sleep };
