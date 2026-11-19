/**
 * B站评论：收件箱（回复我的 / @我的）、回读楼层、发评论、评论列表、删评论。
 *
 * 三个已知坑（旧实现踩过，这里按正确读法处理）：
 *   1. 新版动态 id 是 19 位，超出 JS 安全整数；JSON.parse 会把它舍入成 …700。
 *      → 优先从 item.uri 正则取 id（字符串，不丢精度）；subject_id 只在安全整数内使用，
 *        否则宁可留空 —— 用被截断的 id 会 -404 或挂到错的对象上。
 *   2. 收件箱的 item.title 不可靠（实测多条 title 是同一句，正文有时跑到 source_content）。
 *      → 收件箱只负责"发现有人找"；对方到底说了什么，必须 resolveLatestReply 回读楼层。
 *   3. cursor 翻页会返回重叠数据（同一条出现两遍）→ 按 item.id 去重。
 *
 * 所有网络请求都走 client（createBiliClient 的返回值），本模块不做 fetch：
 * 测试里可以注入假 client；这里也绝不打印 cookie / csrf。
 */
import { BiliError } from './http.js';

const REFERER = 'https://www.bilibili.com/';
const MSGFEED_URL = 'https://api.bilibili.com/x/msgfeed';
const REPLY_ADD_URL = 'https://api.bilibili.com/x/v2/reply/add';
const REPLY_DEL_URL = 'https://api.bilibili.com/x/v2/reply/del';
const REPLY_LIST_URL = 'https://api.bilibili.com/x/v2/reply';
const REPLY_THREAD_URL = 'https://api.bilibili.com/x/v2/reply/reply';

const FEED_KINDS = new Set(['reply', 'at']);
const FEED_MAX_PAGES = 20;
const THREAD_PAGE_SIZE = 20;
const THREAD_MAX_PAGES = 6;
/** 只有"像签名/风控问题"的 code 才值得带 wbi 再试一次；其它失败重试只会重复踩坑。 */
const WBI_RETRY_CODES = new Set([-352, -412]);

function str(value, fallback = '') {
  const out = String(value ?? '').trim();
  return out || fallback;
}

function positiveInt(value, fallback) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * id 保真：字符串原样返回；数字只在安全整数内才可信。
 * ⚠️ 19 位动态 id（如 1261813571425140745）经 JSON.parse 后变成 1261813571425140700，
 *   已经超出 2^53-1 → 一律返回 ''，绝不拿它当 oid。
 */
function exactId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : '';
  return str(value);
}

/** 从 item.uri 取动态 id：t.bilibili.com/xxx 或 bilibili.com/opus/xxx（字符串，不丢精度）。 */
function idFromUri(uri) {
  const match = /(?:t\.bilibili\.com|bilibili\.com\/opus)\/(\d{6,22})/.exec(String(uri ?? ''));
  return match ? match[1] : '';
}

/** 收件箱 business → 评论 type：11/17 是动态，其余都按视频（1）。 */
function replyType(business) {
  const n = Number(business);
  return n === 11 || n === 17 ? n : 1;
}

/** 评论 type 只支持 1 / 11 / 17；写操作宁可报错，也不写到错的对象上。 */
function commentType(value, fallback = 1) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (n === 1 || n === 11 || n === 17) return n;
  throw new Error(`不支持的评论 type=${value}（只支持 1=视频 / 11=图文动态 / 17=转发动态）`);
}

/** 动态评论的 referer 指到 opus 页；视频用站点首页即可（cookie 域相同）。 */
function refererFor(type, oid) {
  if ((type === 11 || type === 17) && oid) return `https://www.bilibili.com/opus/${oid}`;
  return REFERER;
}

/** cursor 的"没有下一页"：空串 / null / 0 / '0' 都算没有。 */
function nextCursor(value) {
  if (value === undefined || value === null || value === '') return '';
  if (value === 0) return '';
  const out = String(value);
  return out === '0' ? '' : out;
}

/**
 * 收件箱单条 → 统一形状。
 * title/source/target 三个字段语义都不可靠，全留着由调用方决定用哪个；
 * oid 优先 uri（保真），root/parent 是回读楼层的坐标。
 */
function feedItem(kind, raw) {
  const uri = str(raw?.item?.uri);
  return {
    kind,
    id: str(raw?.id_str ?? raw?.id),
    t: Number(raw?.reply_time ?? raw?.at_time ?? 0) || 0,
    who: str(raw?.user?.nickname, '?'),
    mid: str(raw?.user?.mid),
    title: str(raw?.item?.title),
    source: str(raw?.item?.source_content),
    target: str(raw?.item?.target_reply_content),
    business: Number(raw?.item?.business_id ?? 1) || 1,
    oid: idFromUri(uri) || exactId(raw?.item?.subject_id),
    root: exactId(raw?.item?.root_id),
    parent: exactId(raw?.item?.source_id),
    uri,
  };
}

/** 评论摘要：顶层评论与二级回复共用这六个字段（二级不带嵌套 replies）。 */
function replySummary(reply) {
  return {
    rpid: str(reply?.rpid_str ?? reply?.rpid),
    mid: str(reply?.mid ?? reply?.member?.mid),
    uname: str(reply?.member?.uname),
    message: String(reply?.content?.message ?? ''),
    like: Number(reply?.like ?? 0) || 0,
    ctime: Number(reply?.ctime ?? 0) || 0,
  };
}

/** 发评论结果里的链接只能由 bvid 拼；拿不到 bvid 就返回空串，不编造。 */
function commentUrl(bvid, rpid) {
  const bv = str(bvid);
  if (!/^BV[0-9A-Za-z]{10}$/.test(bv) || !rpid) return '';
  return `https://www.bilibili.com/video/${bv}#reply${rpid}`;
}

/**
 * @param {object} client createBiliClient() 的返回值（getJson / postForm / signedQuery）
 * @param {{logger?:Function}} options logger 只用于降级/异常提示，不打印凭据
 */
export function createCommentApi(client, { logger = () => {} } = {}) {
  if (!client || typeof client.getJson !== 'function' || typeof client.postForm !== 'function') {
    throw new Error('createCommentApi 需要一个客户端（createBiliClient() 的返回值，含 getJson / postForm）');
  }
  const log = typeof logger === 'function' ? logger : () => {};

  /**
   * 拉收件箱：kind = 'reply'（回复我的）| 'at'（@我的）。
   * → { items:[{kind,id,t,who,mid,title,source,target,business,oid,root,parent,uri}], lastView }
   */
  async function pullInbox(kind, { pages = 1 } = {}) {
    const feed = String(kind ?? '');
    if (!FEED_KINDS.has(feed)) {
      throw new Error(`未知的收件箱类型：${feed || '(空)'}（只能是 reply 或 at）`);
    }
    const limit = Math.min(FEED_MAX_PAGES, positiveInt(pages, 1));
    const items = [];
    const seen = new Set();
    let cursor = '';
    let lastView = 0;

    for (let page = 0; page < limit; page += 1) {
      const query = `platform=web&build=0&mobi_app=web${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const url = `${MSGFEED_URL}/${feed}?${query}`;
      const json = await client.getJson(url, { referer: REFERER });
      const code = Number(json?.code ?? 0);
      if (code !== 0) {
        throw new BiliError(`收件箱 ${feed} code=${code} ${str(json?.message ?? json?.msg)}`.trim(), { code, url });
      }
      if (page === 0) lastView = Number(json?.data?.last_view_at ?? 0) || 0;
      const list = Array.isArray(json?.data?.items) ? json.data.items : [];
      for (const raw of list) {
        const item = feedItem(feed, raw);
        // 翻页重叠：按 item.id 去重（没有 id 的极端情况退化成坐标去重，别重复计同一条）
        const key = item.id ? `id:${item.id}` : `at:${item.kind}|${item.oid}|${item.mid}|${item.parent}|${item.t}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(item);
      }
      cursor = nextCursor(json?.data?.cursor);
      if (!cursor || list.length === 0) break;
    }
    return { items, lastView };
  }

  /**
   * 回读楼层，取"这个人在这个楼里、挂在指定父评论下的那条回复" —— 这才是他真正说的话。
   * parentRpid 是关键：同一个人在一个楼里可能有好几条评论，只有 parent 对上号的才是"新回复"。
   * → { rpid, text, ctime, exact } | null（读不到/没这个人）
   */
  async function resolveLatestReply({ business, oid, root, mid, parentRpid } = {}) {
    const oidText = str(oid);
    const rootText = str(root);
    const midText = str(mid);
    if (!oidText || !rootText || !midText) return null;
    const type = replyType(business);
    const referer = refererFor(type, oidText);
    const replies = [];

    for (let pn = 1; pn <= THREAD_MAX_PAGES; pn += 1) {
      const url = `${REPLY_THREAD_URL}?type=${type}&oid=${encodeURIComponent(oidText)}&root=${encodeURIComponent(rootText)}&ps=${THREAD_PAGE_SIZE}&pn=${pn}`;
      let json = null;
      try {
        json = await client.getJson(url, { referer });
      } catch (error) {
        // 第一页读不到 = 判断不了 → null；后面几页失败就用已经拿到的继续挑
        if (pn === 1) return null;
        log(`回读楼层第 ${pn} 页失败，用已读到的 ${replies.length} 条继续：${error?.message ?? error}`);
        break;
      }
      const code = Number(json?.code ?? 0);
      if (code !== 0) {
        if (pn === 1) return null;
        log(`回读楼层第 ${pn} 页 code=${code}，用已读到的 ${replies.length} 条继续`);
        break;
      }
      const list = Array.isArray(json?.data?.replies) ? json.data.replies : [];
      replies.push(...list);
      if (list.length < THREAD_PAGE_SIZE) break;
    }

    const mine = replies.filter((reply) => str(reply?.mid ?? reply?.member?.mid) === midText);
    if (!mine.length) return null;

    let pick = null;
    const parentText = str(parentRpid);
    if (parentText) {
      // ① 精确：父评论对得上，从后往前取最新的一条
      pick = [...mine].reverse().find((reply) => str(reply?.parent) === parentText) ?? null;
    }
    const exact = Boolean(pick);
    // ② 退路：他最后一条（可能不是最新的那条 → exact:false，调用方自己决定信不信）
    if (!pick) pick = mine[mine.length - 1];
    return {
      rpid: str(pick?.rpid_str ?? pick?.rpid),
      text: String(pick?.content?.message ?? ''),
      ctime: Number(pick?.ctime ?? 0) || 0,
      exact,
    };
  }

  /**
   * 写操作必须拿到结果对象（真实 postForm 一定返回）；拿不到就 fail closed，
   * 别把"没结果"当成"发出去了"。
   */
  function writeResult(result, action, url) {
    if (result && typeof result === 'object') return result;
    throw new BiliError(`${action}没有返回可解析的结果（HTTP 层异常）`, { url });
  }

  /**
   * 发评论 / 回复（root+parent 就是楼中楼）。
   * 先不带 wbi 直接 POST（这两个接口在正常登录态下不需要签名）；只有撞上签名/风控类 code
   * 才带 wbi 再试一次，签名本身失败就安静降级（保留第一次的错误，不假装成功）。
   * → { rpid, url }（url 只有调用方给了 bvid 才拼，否则空串）
   */
  async function post({ oid, type = 1, message, root = 0, parent = 0, bvid = '' } = {}) {
    const oidText = str(oid);
    if (!oidText) throw new Error('发评论缺少 oid');
    const text = String(message ?? '');
    if (!text.trim()) throw new Error('发评论缺少正文 message');
    const typeNum = commentType(type);
    const referer = refererFor(typeNum, oidText);
    const fields = {
      oid: oidText,
      type: typeNum,
      message: text,
      root,
      parent,
      plat: 1,
    };

    let result = writeResult(await client.postForm(REPLY_ADD_URL, fields, { referer }), '发评论', REPLY_ADD_URL);
    let code = Number(result.code ?? 0);
    if (code !== 0 && WBI_RETRY_CODES.has(code) && typeof client.signedQuery === 'function') {
      const signed = await signForRetry(fields);
      if (signed) {
        result = writeResult(await client.postForm(`${REPLY_ADD_URL}?${signed}`, fields, { referer }), '发评论（带 wbi）', REPLY_ADD_URL);
        code = Number(result.code ?? 0);
      }
    }
    if (code !== 0) {
      const messageText = str(result.message ?? result.msg);
      throw new BiliError(`发评论失败 code=${code}${messageText ? ` ${messageText}` : ''}`, {
        code,
        url: REPLY_ADD_URL,
        status: Number(result.httpStatus ?? 0) || 0,
      });
    }
    const rpid = str(result.data?.rpid_str ?? result.data?.rpid);
    if (!rpid) log('发评论返回成功，但没拿到 rpid（无法拼回复链接）');
    return { rpid, url: commentUrl(bvid, rpid) };
  }

  /** 可选分支：拿 wbi 查询串；拿不到就返回空串（降级成不带签名的请求）。 */
  async function signForRetry(fields) {
    try {
      const query = await client.signedQuery(fields);
      return str(query);
    } catch (error) {
      log(`wbi 签名失败，退回不带签名的请求：${error?.message ?? error}`);
      return '';
    }
  }

  /**
   * 评论列表（顶层评论 + 每条下面二级回复的摘要）。
   * → { page:{pn,ps,count}, items:[{rpid,mid,uname,message,like,ctime,replies:[…摘要]}] }
   */
  async function list({ oid, type = 1, pn = 1, ps = 20, sort = 2 } = {}) {
    const oidText = str(oid);
    if (!oidText) throw new Error('评论列表缺少 oid');
    const typeNum = commentType(type);
    const pageNo = positiveInt(pn, 1);
    const pageSize = positiveInt(ps, 20);
    const sortNum = Number.isFinite(Number(sort)) ? Number(sort) : 2;
    const url = `${REPLY_LIST_URL}?type=${typeNum}&oid=${encodeURIComponent(oidText)}&pn=${pageNo}&ps=${pageSize}&sort=${sortNum}`;
    const json = await client.getJson(url, { referer: refererFor(typeNum, oidText) });
    const code = Number(json?.code ?? 0);
    if (code !== 0) {
      throw new BiliError(`评论列表 code=${code} ${str(json?.message ?? json?.msg)}`.trim(), { code, url });
    }
    const data = json?.data ?? {};
    const replies = Array.isArray(data.replies) ? data.replies : [];
    return {
      page: {
        pn: Number(data.page?.pn ?? pageNo) || pageNo,
        ps: Number(data.page?.size ?? data.page?.ps ?? pageSize) || pageSize,
        count: Number(data.page?.count ?? data.page?.acount ?? 0) || 0,
      },
      items: replies.map((reply) => ({
        ...replySummary(reply),
        replies: Array.isArray(reply?.replies) ? reply.replies.map(replySummary) : [],
      })),
    };
  }

  /** 删自己发的评论。→ { ok:true }；code!==0 抛错。 */
  async function remove({ oid, type = 1, rpid } = {}) {
    const oidText = str(oid);
    const rpidText = str(rpid);
    if (!oidText) throw new Error('删除评论缺少 oid');
    if (!rpidText) throw new Error('删除评论缺少 rpid');
    const typeNum = commentType(type);
    const fields = { oid: oidText, type: typeNum, rpid: rpidText };
    const result = writeResult(await client.postForm(REPLY_DEL_URL, fields, { referer: refererFor(typeNum, oidText) }), '删除评论', REPLY_DEL_URL);
    const code = Number(result.code ?? 0);
    if (code !== 0) {
      const messageText = str(result.message ?? result.msg);
      throw new BiliError(`删除评论失败 code=${code}${messageText ? ` ${messageText}` : ''}`, {
        code,
        url: REPLY_DEL_URL,
        status: Number(result.httpStatus ?? 0) || 0,
      });
    }
    return { ok: true };
  }

  return { pullInbox, resolveLatestReply, post, list, remove };
}
