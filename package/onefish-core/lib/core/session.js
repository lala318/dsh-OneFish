/**
 * 统一会话（MVP）：记录 DSH 会话与核心频道的映射。
 *
 * 第一频道只有 DSH 对话窗口：
 *   dsh:<sessionId>
 * 后续 QQ / B站 / 桌宠组件接入时，沿用同一个 conversation 结构。
 */
import fs from 'node:fs';
import path from 'node:path';

function readJson(file, fallback = null) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function emptyStore() {
  return { version: 1, conversations: {} };
}

export function createSessionService({ paths, logger = () => {} }) {
  function read() {
    const raw = readJson(paths.sessionsFile, null);
    if (!raw || typeof raw !== 'object' || !raw.conversations || typeof raw.conversations !== 'object') {
      return emptyStore();
    }
    return { version: 1, conversations: raw.conversations };
  }

  function write(store) {
    writeJsonAtomic(paths.sessionsFile, { version: 1, conversations: store.conversations });
  }

  function touchDsh(sessionId, event = {}) {
    const id = String(sessionId || event?.sessionId || '').trim();
    if (!id) return null;
    const key = `dsh:${id}`;
    const store = read();
    const now = Date.now();
    const prev = store.conversations[key] || {
      key,
      channel: 'dsh',
      id,
      createdAt: now,
      messageCount: 0,
    };
    const eventType = String(event?.type || event?.event?.type || '').trim();
    store.conversations[key] = {
      ...prev,
      updatedAt: now,
      lastEventType: eventType || prev.lastEventType || '',
      messageCount: Number(prev.messageCount || 0) + (eventType && eventType !== 'heartbeat' ? 1 : 0),
    };
    write(store);
    return store.conversations[key];
  }

  function list({ limit = 20 } = {}) {
    const rows = Object.values(read().conversations)
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    return rows.slice(0, Math.max(1, Math.min(100, Number(limit) || 20)));
  }

  function current() {
    return list({ limit: 1 })[0] || null;
  }

  function get(key) {
    return read().conversations[String(key || '')] || null;
  }

  function stats() {
    const rows = Object.values(read().conversations);
    return {
      conversations: rows.length,
      messages: rows.reduce((sum, row) => sum + Number(row.messageCount || 0), 0),
      lastAt: rows.reduce((max, row) => Math.max(max, Number(row.updatedAt || 0)), 0),
    };
  }

  return { touchDsh, list, current, get, stats };
}
