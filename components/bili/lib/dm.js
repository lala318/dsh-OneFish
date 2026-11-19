/**
 * B站私信：会话列表 / 发送。
 *
 * 边界（照旧系统的写死规则，收紧不放宽）：
 *   - 发主人：不限条数（长度仍受 config.outbound.maxDmLength 限制）；
 *   - 发别人：只能「回」，会话最后一条必须是对面说的；默认 48 小时内；不主动开新会话；
 *   - 系统/官方号（mid < 1000）不回复；
 *   - 本模块不打印 cookie / csrf。
 */
import crypto from 'node:crypto';

const SESSIONS_URL = 'https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions?session_type=1&group_id=0&count=50&mobi_app=web';
const SEND_URL = 'https://api.vc.bilibili.com/web_im/v1/web_im/send_msg';

/** 私信 content 可能是 {"content":"…"} 也可能是纯文本。 */
export function parseDmContent(content) {
  const raw = String(content ?? '');
  try {
    const json = JSON.parse(raw);
    if (json && typeof json === 'object') {
      const value = json.content ?? json.text ?? json.msg ?? '';
      if (typeof value === 'string') return value;
    }
  } catch {}
  return raw;
}

export function normalizeSession(session, selfMid = '') {
  const talker = String(session?.talker_id ?? session?.talkerId ?? '').trim();
  const last = session?.last_msg ?? session?.lastMsg ?? {};
  const sender = String(last?.sender_uid ?? last?.senderUid ?? '').trim();
  return {
    mid: talker,
    name: String(session?.account_info?.name ?? session?.talker_name ?? session?.name ?? '').trim(),
    lastText: parseDmContent(last?.content),
    ts: Number(last?.timestamp ?? 0) || 0,
    unread: Number(session?.unread_count ?? session?.unreadCount ?? 0) || 0,
    lastSender: sender,
    lastFromSelf: Boolean(sender) && String(sender) === String(selfMid || ''),
    msgType: Number(last?.msg_type ?? last?.msgType ?? 0) || 0,
    system: Number(talker) < 1000,
  };
}

/**
 * @param {ReturnType<import('./http.js').createBiliClient>} client
 */
export function createDmApi(client, { config = {}, logger = () => {}, now = () => Date.now() } = {}) {
  const selfMid = String(client?.self?.mid || '');
  const ownerMid = String(config?.owner?.mid || '');
  const maxLength = Number(config?.outbound?.maxDmLength) || 300;
  const allowStranger = config?.outbound?.allowStrangerDm !== false;

  async function sessions({ count = 50 } = {}) {
    const safeCount = Math.min(100, Math.max(1, Number(count) || 50));
    const url = SESSIONS_URL.replace('count=50', `count=${safeCount}`);
    const json = await client.getJson(url, { referer: 'https://message.bilibili.com/' });
    const list = json?.data?.session_list ?? [];
    return list
      .map((item) => normalizeSession(item, selfMid))
      .filter((item) => item.mid && item.mid !== selfMid)
      .sort((a, b) => b.ts - a.ts);
  }

  /** 拉某个会话的历史消息（最新在前，返回时按时间正序）。 */
  async function messages({ mid, size = 20 } = {}) {
    const target = String(mid ?? '').trim();
    if (!/^\d{1,20}$/.test(target)) throw new Error('mid 不是有效数字');
    const safeSize = Math.min(50, Math.max(1, Number(size) || 20));
    const url = `https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs?session_type=1&talker_id=${target}&size=${safeSize}&mob_app=web`;
    const json = await client.getJson(url, { referer: 'https://message.bilibili.com/' });
    const raw = json?.data?.messages ?? [];
    return raw
      .map((item) => ({
        senderIsSelf: String(item?.sender_uid ?? '') === selfMid,
        ts: Number(item?.timestamp ?? 0) || 0,
        type: Number(item?.msg_type ?? 0) || 0,
        text: parseDmContent(item?.content),
      }))
      .sort((a, b) => a.ts - b.ts);
  }

  /** 能不能发：返回 { ok, reason }，不做网络请求。 */
  function canSend({ mid, sessions: cached = [] }) {
    const target = String(mid ?? '').trim();
    if (!/^\d{1,20}$/.test(target)) return { ok: false, reason: 'mid 不是有效数字' };
    if (!selfMid) return { ok: false, reason: '不知道自己是哪个账号（凭据缺 mid）' };
    if (target === selfMid) return { ok: false, reason: '不能给自己发私信' };
    if (Number(target) < 1000) return { ok: false, reason: '这个 mid 是系统/官方号，不回复' };
    if (ownerMid && target === ownerMid) return { ok: true, reason: 'owner' };
    if (!allowStranger) return { ok: false, reason: '组件配置只允许私信主人（allowStrangerDm=false）' };
    const session = cached.find((item) => item.mid === target);
    if (!session) return { ok: false, reason: '没有会话：陌生人通道只能回，不能主动发' };
    if (session.lastFromSelf) return { ok: false, reason: '会话最后一条是我发的，等对方再说话' };
    const ageMs = now() - (Number(session.ts) || 0) * 1000;
    if (Number(session.ts) > 0 && ageMs > 48 * 3600 * 1000) {
      return { ok: false, reason: '对方那条超过 48 小时了，现在回像诈尸' };
    }
    return { ok: true, reason: 'stranger-reply' };
  }

  async function send({ mid, text } = {}) {
    const body = String(text ?? '').trim();
    if (!body) throw new Error('私信内容不能为空');
    if (body.length > maxLength) throw new Error(`私信太长（${body.length} > ${maxLength} 字），精简一下`);
    if (body.includes('\u0000')) throw new Error('私信内容包含非法字符');
    const sessionsCache = await sessions();
    const verdict = canSend({ mid, sessions: sessionsCache });
    if (!verdict.ok) throw new Error(`不能发这条私信：${verdict.reason}`);
    const target = String(mid).trim();

    const form = {
      'msg[sender_uid]': selfMid,
      'msg[receiver_id]': target,
      'msg[receiver_type]': 1,
      'msg[msg_type]': 1,
      'msg[msg_status]': 0,
      'msg[timestamp]': Math.floor(now() / 1000),
      'msg[dev_id]': `WEB-${crypto.randomUUID().toUpperCase()}`,
      'msg[content]': JSON.stringify({ content: body }),
    };
    const result = await client.postForm(SEND_URL, form, { referer: 'https://message.bilibili.com/' });
    if (result.code !== 0) {
      throw new Error(`私信发送失败：code=${result.code} ${result.message || ''}`.trim());
    }
    const session = sessionsCache.find((item) => item.mid === target);
    logger(`私信已发 mid=${target} chars=${body.length} kind=${verdict.reason}`);
    return {
      ok: true,
      mid: target,
      name: session?.name || '',
      kind: verdict.reason,
      chars: body.length,
    };
  }

  return { sessions, messages, canSend, send, selfMid, ownerMid };
}
