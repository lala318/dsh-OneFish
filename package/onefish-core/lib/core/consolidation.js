/**
 * 把 DSH 会话事件整理成可归档的消息。
 *
 * 这一层只做“读事件 → 文本消息”，不调用 LLM；全量档案保留原文，
 * 日摘要只是索引。后续的 memory-space 提炼可以在这个结果上再做。
 */
import { createHash } from 'node:crypto';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 从 content blocks 里抽文本；忽略图片/工具块等非文本内容。 */
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (!isObject(part)) return '';
      if (part.type === 'text') return String(part.text || '');
      if (part.type === 'input_text') return String(part.text || '');
      if (part.type === 'output_text') return String(part.text || '');
      return '';
    }).filter(Boolean).join('\n');
  }
  if (isObject(content)) {
    if (typeof content.text === 'string') return content.text;
    return contentText(content.content);
  }
  return '';
}

function messageOf(event) {
  const data = isObject(event?.data) ? event.data : {};
  const message = isObject(data.message) ? data.message : data;
  const role = String(message.role || data.role || (event?.type === 'user/message' ? 'user' : 'assistant'));
  const text = contentText(message.content ?? data.content ?? message.text ?? data.text).trim();
  return { role, text };
}

/** 一条 history record → 一条归档消息；不是消息事件返回 null。 */
export function normalizeRecord(record) {
  const event = record?.event ?? record;
  if (!isObject(event)) return null;
  const type = String(event.type || '');
  if (type !== 'user/message' && type !== 'assistant/message') return null;
  const { role, text } = messageOf(event);
  if (!text) return null;
  const rawAt = event.at ?? event.time ?? event.timestamp ?? event.data?.at ?? 0;
  const at = typeof rawAt === 'string' ? (Date.parse(rawAt) || 0) : (Number(rawAt) || 0);
  return {
    seq: Number(event.seq ?? 0),
    type,
    role,
    text,
    at,
  };
}

export function normalizeRecords(records) {
  const out = [];
  for (const record of Array.isArray(records) ? records : []) {
    const message = normalizeRecord(record);
    if (message) out.push(message);
  }
  return out;
}

export function sourceHash(messages) {
  const body = messages.map((m) => JSON.stringify({
    seq: m.seq,
    type: m.type,
    role: m.role,
    at: m.at,
    text: m.text,
  })).join('\n');
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function clip(text, max = 500) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** 生成可读日摘要；完整内容仍在 archive JSONL。 */
export function buildDigest({ day, sessionId = '', messages = [], sourceHash: hash = '' }) {
  const users = messages.filter((m) => m.role === 'user');
  const assistants = messages.filter((m) => m.role !== 'user');
  const first = messages[0]?.at ? new Date(messages[0].at) : null;
  const last = messages[messages.length - 1]?.at ? new Date(messages[messages.length - 1].at) : null;
  const lines = [
    `# OneFish ${day}`,
    '',
    `- 会话：${sessionId || '—'}`,
    `- 消息：${messages.length}（用户 ${users.length} / 助手 ${assistants.length}）`,
    `- 时间：${first ? first.toLocaleString() : '—'} → ${last ? last.toLocaleString() : '—'}`,
    `- 源哈希：${hash || '—'}`,
    '',
  ];
  if (users.length) {
    lines.push('## 用户', '');
    for (const m of users.slice(0, 80)) lines.push(`- ${clip(m.text)}`);
    lines.push('');
  }
  if (assistants.length) {
    lines.push('## 助手', '');
    for (const m of assistants.slice(0, 80)) lines.push(`- ${clip(m.text)}`);
    lines.push('');
  }
  return lines.join('\n');
}
