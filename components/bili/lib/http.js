/**
 * B站 HTTP 客户端：cookie 头、WBI 签名、JSON 请求。
 *
 * - 不打印 cookie / csrf；
 * - 只做传输层，业务语义（什么时候回读楼层、什么算未读）留给各模块；
 * - 所有请求带超时，失败抛 BiliError（含 code，便于上层区分 -101 未登录 / -412 风控）。
 */
import crypto from 'node:crypto';
import { cookieHeader } from './credentials.js';

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9,
  42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1,
  60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

export class BiliError extends Error {
  constructor(message, { code = 0, url = '', status = 0 } = {}) {
    super(message);
    this.name = 'BiliError';
    this.code = code;
    this.url = url;
    this.status = status;
  }
}

function cleanWbiValue(value) {
  return String(value ?? '').replace(/[!'()*]/g, '');
}

function keyName(url) {
  const base = String(url || '').split('/').pop() || '';
  return base.split('.')[0];
}

/** 生成 WBI 签名字符串：`a=1&b=2&wts=...&w_rid=...`（不含前导 ?）。 */
export function wbiQuery(params, { raw, nowSec } = {}) {
  const mixin = MIXIN_TAB.map((i) => String(raw ?? '')[i] ?? '').join('').slice(0, 32);
  const wts = Math.round(Number(nowSec) || Math.floor(Date.now() / 1000));
  const all = { ...params, wts };
  const query = Object.keys(all)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(cleanWbiValue(all[k]))}`)
    .join('&');
  const wRid = crypto.createHash('md5').update(query + mixin).digest('hex');
  return `${query}&w_rid=${wRid}`;
}

/**
 * @param {{sessdata:string,bili_jct:string,buvid3:string,mid?:string,name?:string}} credentials
 * @param {{fetchImpl?:Function, logger?:Function, timeoutMs?:number}} options
 */
export function createBiliClient(credentials, { fetchImpl = fetch, logger = () => {}, timeoutMs = 15000 } = {}) {
  if (!credentials?.sessdata || !credentials?.bili_jct) {
    throw new BiliError('B站凭据不完整（缺 sessdata / bili_jct）', { code: -101 });
  }
  const cookie = cookieHeader(credentials);
  let wbiCache = null;

  function headers(referer = 'https://www.bilibili.com/') {
    return {
      'user-agent': UA,
      referer,
      cookie,
      origin: 'https://www.bilibili.com',
    };
  }

  async function request(url, { method = 'GET', body, referer, accept = 'application/json', contentType = '' } = {}) {
    const init = { method, headers: { ...headers(referer), accept } };
    if (contentType) init.headers['content-type'] = contentType;
    if (body !== undefined) init.body = body;
    let response;
    try {
      response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new BiliError(`请求失败：${error?.name === 'TimeoutError' ? '超时' : String(error?.message ?? error)}`, { url });
    }
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    if (!json) {
      throw new BiliError(`返回不是 JSON（HTTP ${response.status}）`, { status: response.status, url });
    }
    return { status: response.status, json };
  }

  /** GET 并返回 json；code !== 0 时抛错（默认），allowCode 可放行特定 code。 */
  async function getJson(url, { referer, allowCode = [] } = {}) {
    const { status, json } = await request(url, { referer });
    const code = Number(json?.code ?? 0);
    if (code !== 0 && !allowCode.includes(code)) {
      throw new BiliError(`B站接口 code=${code} ${json?.message || json?.msg || ''}`.trim(), { code, status, url });
    }
    return json;
  }

  /** POST 表单（自动带 csrf）。返回原始 json，由调用方判断 code。 */
  async function postForm(url, fields = {}, { referer } = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue;
      params.set(key, String(value));
    }
    if (!params.has('csrf')) params.set('csrf', String(credentials.bili_jct));
    const { status, json } = await request(url, {
      method: 'POST',
      referer,
      body: params.toString(),
      contentType: 'application/x-www-form-urlencoded',
    });
    return {
      httpStatus: status,
      code: Number(json?.code ?? 0),
      message: String(json?.message ?? json?.msg ?? ''),
      data: json?.data ?? null,
    };
  }

  async function nav() {
    return getJson('https://api.bilibili.com/x/web-interface/nav', { allowCode: [-101] });
  }

  /** 取 WBI raw key（img_key + sub_key），10 分钟缓存。 */
  async function wbiRaw() {
    const now = Date.now();
    if (wbiCache && now - wbiCache.at < 10 * 60 * 1000) return wbiCache.raw;
    const j = await nav();
    const img = keyName(j?.data?.wbi_img?.img_url);
    const sub = keyName(j?.data?.wbi_img?.sub_url);
    if (!img || !sub) throw new BiliError('拿不到 WBI key（未登录或接口变更）', { code: -101 });
    wbiCache = { raw: img + sub, at: now };
    return wbiCache.raw;
  }

  /** 带签名的查询串。 */
  async function signedQuery(params = {}) {
    const raw = await wbiRaw();
    return wbiQuery(params, { raw });
  }

  return {
    credentials,
    self: { mid: String(credentials.mid || ''), name: String(credentials.name || '') },
    csrf: String(credentials.bili_jct),
    headers,
    request,
    getJson,
    postForm,
    nav,
    signedQuery,
    wbiRaw,
  };
}
