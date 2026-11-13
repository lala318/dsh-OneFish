/**
 * 日会话索引的持久化。
 *
 * 只存 day → sessionId 和整理状态；消息历史属于 DSH，不在这里。
 */
import fs from 'node:fs';
import path from 'node:path';

function emptyState() {
  return { version: 1, active: null, recent: [] };
}

function readJson(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const day = String(entry.day || '').trim();
  const sessionId = String(entry.sessionId || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !sessionId) return null;
  return {
    day,
    sessionId,
    preset: String(entry.preset || ''),
    createdAt: Number(entry.createdAt || 0),
    sealedAt: Number(entry.sealedAt || 0),
    lastActivityAt: Number(entry.lastActivityAt || 0),
    eventCount: Number(entry.eventCount || 0),
    status: ['active', 'pending', 'consolidated', 'failed', 'retired'].includes(entry.status) ? entry.status : 'pending',
    archivePath: typeof entry.archivePath === 'string' ? entry.archivePath : '',
    digestPath: typeof entry.digestPath === 'string' ? entry.digestPath : '',
    sourceHash: typeof entry.sourceHash === 'string' ? entry.sourceHash : '',
    consolidatedAt: Number(entry.consolidatedAt || 0),
    archivedAt: Number(entry.archivedAt || 0),
    lastError: typeof entry.lastError === 'string' ? entry.lastError : '',
    attempts: Number(entry.attempts || 0),
  };
}

function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') return emptyState();
  const active = normalizeEntry(raw.active);
  if (active) active.status = 'active';
  const seen = new Set();
  const recent = [];
  for (const item of Array.isArray(raw.recent) ? raw.recent : []) {
    const entry = normalizeEntry(item);
    if (!entry || seen.has(entry.day)) continue;
    seen.add(entry.day);
    recent.push(entry);
  }
  recent.sort((a, b) => b.day.localeCompare(a.day));
  return { version: 1, active, recent };
}

export function createSessionIndexStore({ paths }) {
  function read() {
    return normalizeState(readJson(paths.sessionIndexFile));
  }

  function write(state) {
    const normalized = normalizeState(state);
    writeJsonAtomic(paths.sessionIndexFile, normalized);
    return normalized;
  }

  function setActive(entry) {
    const state = read();
    const normalized = normalizeEntry(entry);
    if (!normalized) throw new Error('invalid active session entry');
    state.active = normalized;
    // 保留同一天的 recent 条目：手动 retire 后重建同一天会话时，旧索引仍可追溯。
    return write(state);
  }

  function sealActive({ status = 'pending', sealedAt = Date.now() } = {}) {
    const state = read();
    if (!state.active) return null;
    const sealed = {
      ...state.active,
      sealedAt: Number(sealedAt) || Date.now(),
      status,
    };
    state.recent = [sealed, ...state.recent.filter((item) => item.day !== sealed.day)]
      .sort((a, b) => b.day.localeCompare(a.day));
    state.active = null;
    write(state);
    return sealed;
  }

  function updateRecent(day, patch = {}) {
    const state = read();
    const index = state.recent.findIndex((item) => item.day === day);
    if (index === -1) return null;
    state.recent[index] = normalizeEntry({ ...state.recent[index], ...patch });
    write(state);
    return state.recent[index];
  }

  function find(day) {
    const state = read();
    if (state.active?.day === day) return state.active;
    return state.recent.find((item) => item.day === day) || null;
  }

  function removeRecent(day) {
    const state = read();
    state.recent = state.recent.filter((item) => item.day !== day);
    write(state);
  }

  return { read, write, setActive, sealActive, updateRecent, find, removeRecent };
}
