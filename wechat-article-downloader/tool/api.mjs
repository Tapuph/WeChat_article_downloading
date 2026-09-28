// 稳健的公众平台接口调用层：处理 200013 限流、会话失效、自动退避。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
export const CREDS_PATH = path.join(ROOT, 'creds.json');

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export function loadCreds() {
  if (!fs.existsSync(CREDS_PATH)) throw new Error(`缺少凭证文件 ${CREDS_PATH}，请先运行: node tool/login.mjs`);
  const c = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
  if (!c.token || !c.cookie) throw new Error('creds.json 不完整，请重新运行 node tool/login.mjs');
  return c;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SessionExpired extends Error {
  constructor(msg) { super(msg); this.name = 'SessionExpired'; }
}

/**
 * 调用一个 cgi-bin 接口，自动处理限流退避。
 * onNotice: (msg) => void  用于把进度写进日志
 */
export async function callApi(creds, pathAndQuery, {
  method = 'GET',
  body = null,
  contentType = null,
  maxRetries = 6,
  baseDelayMs = 45000,
  maxDelayMs = 20 * 60 * 1000,
  onNotice = console.log,
  expectJson = true,
} = {}) {
  const url = `https://mp.weixin.qq.com${pathAndQuery}`;
  let attempt = 0;
  while (true) {
    attempt++;
    let r, text;
    try {
      r = await fetch(url, {
        method,
        headers: {
          'User-Agent': UA,
          Cookie: creds.cookie,
          Referer: `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=10&isMul=1&token=${creds.token}&lang=zh_CN`,
          'X-Requested-With': 'XMLHttpRequest',
          Accept: 'application/json, text/javascript, */*; q=0.01',
          ...(contentType ? { 'Content-Type': contentType } : {}),
        },
        body,
        redirect: 'follow',
      });
      text = await r.text();
    } catch (e) {
      if (attempt > maxRetries) throw new Error(`网络请求失败（重试 ${attempt} 次）: ${e.message}`);
      const wait = Math.min(baseDelayMs * attempt, maxDelayMs);
      onNotice(`网络异常(${e.message})，${Math.round(wait / 1000)}s 后重试…`);
      await sleep(wait);
      continue;
    }

    // 会话失效 → 页面回登录页
    if (/<title>微信公众平台<\/title>/.test(text) && !text.trim().startsWith('{') && !expectJson) {
      throw new SessionExpired('会话已失效，需要重新登录');
    }

    let j = null;
    if (expectJson) {
      try { j = JSON.parse(text); } catch {}
      if (!j) {
        if (text.includes('登录') && text.length < 20000 && !text.includes('app_msg_list')) {
          throw new SessionExpired('接口返回的不是 JSON（可能是登录页）→ 需要重新登录');
        }
        if (attempt > maxRetries) throw new Error(`响应无法解析为 JSON: ${text.slice(0, 200)}`);
        await sleep(baseDelayMs);
        continue;
      }
      const ret = j.base_resp?.ret;
      if (ret === 0) return j;

      // 频率控制 / 频繁 → 指数退避
      if (ret === 200013 || ret === -6 || /freq|频繁|频率/.test(j.base_resp?.err_msg || '')) {
        if (attempt > maxRetries) {
          throw new Error(`持续被限流（已重试 ${attempt} 次，最后错误: ${j.base_resp?.err_msg}）`);
        }
        const wait = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
        onNotice(`被限流 ret=${ret} (${j.base_resp?.err_msg}) — 第 ${attempt}/${maxRetries} 次退避，等待 ${Math.round(wait / 1000)}s …`);
        await sleep(wait);
        continue;
      }
      if (ret === 200003 || /invalid session|登录/.test(j.base_resp?.err_msg || '')) {
        throw new SessionExpired(`凭证失效: ret=${ret} ${j.base_resp?.err_msg} → 重新运行 node tool/login.mjs`);
      }
      // 其他业务错误：交给调用方判断
      return j;
    }

    return text;
  }
}

/** 按公众号名称搜索 fakeid。 */
export async function searchAccount(creds, name, { count = 5, onNotice } = {}) {
  const j = await callApi(
    creds,
    `/cgi-bin/searchbiz?action=search_biz&begin=0&count=${count}&query=${encodeURIComponent(name)}&token=${creds.token}&lang=zh_CN&f=json&ajax=1`,
    { onNotice },
  );
  return j.list || [];
}

/**
 * 枚举某公众号的历史文章（一页）。
 * 返回 { list, total }
 */
export async function listArticles(creds, fakeid, begin, count = 5, { onNotice } = {}) {
  const q =
    `/cgi-bin/appmsg?action=list_ex&begin=${begin}&count=${count}` +
    `&fakeid=${encodeURIComponent(fakeid)}&type=9&query=&token=${creds.token}` +
    `&lang=zh_CN&f=json&ajax=1&random=${Math.random()}`;
  const j = await callApi(creds, q, { onNotice });
  const list = j.app_msg_list || [];
  const total = Number(j.app_msg_list?.[0]?.total_count ?? j.total_count ?? 0);
  return { list, total, raw: j };
}
