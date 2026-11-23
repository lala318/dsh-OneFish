/**
 * B站「刷」：首页推荐 / 热门 / 排行榜（只读）。
 *
 * 设计：
 * - 只做业务编排：WBI 签名与 cookie 头复用 http.js（推荐流必须签名 + 登录态）；
 * - 三种流给同一套字段，上层不用记得哪个接口用 item 哪个用 list；
 * - 非稿件条目（直播、广告卡、活动页）没有 bvid，直接跳过并在 count 里说清楚；
 * - 纯只读，不发任何写请求。
 */
import { BiliError } from './http.js';

const API = 'https://api.bilibili.com';
const DESC_LIMIT = 140;

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function toText(value, fallback = '') {
  return String(value ?? '').trim() || fallback;
}

function shortDesc(value) {
  const raw = toText(value).replace(/\s+/g, ' ');
  return raw.length > DESC_LIMIT ? `${raw.slice(0, DESC_LIMIT - 1)}…` : raw;
}

/**
 * 把 popular / ranking 的 list 条目或 recommend 的 item 条目归一成同一种形状。
 * 没有 bvid 的（直播 / 广告 / 活动）返回 null，由调用方跳过。
 */
export function normalizeFeedItem(item, { kind = 'recommend' } = {}) {
  if (!item || typeof item !== 'object') return null;
  const bvid = toText(item.bvid);
  if (!bvid) return null;
  const stat = item.stat || {};
  return {
    kind,
    bvid,
    aid: toInt(item.aid ?? item.id),
    cid: toInt(item.cid),
    title: toText(item.title, '(无标题)'),
    owner: toText(item.owner?.name),
    ownerMid: toText(item.owner?.mid),
    tname: toText(item.tname),
    duration: toInt(item.duration),
    views: toInt(stat.view),
    likes: toInt(stat.like),
    danmaku: toInt(stat.danmaku),
    pubdate: toInt(item.pubdate),
    desc: shortDesc(item.desc),
    url: `https://www.bilibili.com/video/${bvid}`,
  };
}

function pack(kind, raw, extra = {}) {
  const list = Array.isArray(raw) ? raw : [];
  const items = list.map((item) => normalizeFeedItem(item, { kind })).filter(Boolean);
  return {
    kind,
    count: items.length,
    skipped: list.length - items.length,
    ...extra,
    items,
  };
}

/**
 * @param {{getJson:Function, signedQuery:Function}} client
 */
export function createFeedApi(client) {
  if (!client || typeof client.getJson !== 'function' || typeof client.signedQuery !== 'function') {
    throw new TypeError('createFeedApi(client) 需要 createBiliClient 返回的客户端');
  }

  /** 首页推荐：必须 WBI 签名；fresh_idx 越大越往下翻，主页一次 20 条左右。 */
  async function recommend({ ps = 20, freshIdx = 1 } = {}) {
    const size = Math.min(Math.max(toInt(ps, 20), 1), 30);
    const query = await client.signedQuery({
      ps: size,
      fresh_idx: Math.max(toInt(freshIdx, 1), 0),
      fresh_type: 4,
      feed_version: 'V8',
      homepage_ver: 1,
      brush: 0,
    });
    const json = await client.getJson(`${API}/x/web-interface/wbi/index/top/feed/rcmd?${query}`, {
      referer: 'https://www.bilibili.com/',
    });
    return pack('recommend', json?.data?.item, { ps: size, freshIdx: Math.max(toInt(freshIdx, 1), 0) });
  }

  /** 热门：不签名，但要有登录 cookie 才不被 -352 挡。 */
  async function popular({ ps = 20, pn = 1 } = {}) {
    const size = Math.min(Math.max(toInt(ps, 20), 1), 50);
    const page = Math.max(toInt(pn, 1), 1);
    const json = await client.getJson(`${API}/x/web-interface/popular?ps=${size}&pn=${page}`, {
      referer: 'https://www.bilibili.com/v/popular/all',
    });
    return pack('popular', json?.data?.list, { ps: size, pn: page, noMore: Boolean(json?.data?.no_more) });
  }

  /** 排行榜：rid=0 全站，其余是分区 id。 */
  async function ranking({ rid = 0 } = {}) {
    const region = Math.max(toInt(rid, 0), 0);
    const json = await client.getJson(`${API}/x/web-interface/ranking/v2?rid=${region}&type=all`, {
      referer: 'https://www.bilibili.com/v/popular/rank/all',
    });
    return pack('ranking', json?.data?.list, { rid: region });
  }

  async function list({ kind = 'recommend', ps, pn, freshIdx, rid } = {}) {
    switch (String(kind || 'recommend')) {
      case 'recommend':
        return recommend({ ps, freshIdx });
      case 'popular':
        return popular({ ps, pn });
      case 'ranking':
        return ranking({ rid });
      default:
        throw new BiliError(`不认识的流：${kind}（只支持 recommend / popular / ranking）`);
    }
  }

  return { list, recommend, popular, ranking };
}
