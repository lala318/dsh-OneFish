// 统一记忆空间（2026-11-08）—— 档案层之外的「主动记忆」。
//
// 分层：
//   档案层：memory-v2/days/*.jsonl + digest，记录发生过什么，append-only；
//   记忆空间：本文件，agent 主动维护的事实/偏好/关系/承诺/黑话/未完成的事。
//
// 空间内三档：
//   core      —— 身份、边界、长期承诺、真正不能忘的事；每天全量注入；
//   active    —— 偏好、近况、项目事实、待办；按重要性/新近度选择性注入；
//   knowledge —— 黑话、梗、表情语义；不常驻注入，按需检索。
//
// 物理上只有 entries.jsonl 一份源；status/audit 只记录整理与审核轨迹。
import fs from 'node:fs';
import path from 'node:path';

export const SPACE_TIERS = Object.freeze(['core', 'active', 'knowledge']);
export const SPACE_STATUSES = Object.freeze(['active', 'draft', 'rejected']);
export const SPACE_KINDS = Object.freeze([
  'fact', 'preference', 'relation', 'commitment', 'open_loop',
  'slang', 'meme', 'sticker', 'other',
]);
export const DEFAULT_SPACE = 'master';

const MAX_TEXT = 1200;
const MAX_TAGS = 8;

const clampInt = (value, fallback, min, max) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(Math.min(max, Math.max(min, n)));
};

const asArray = (value) => (Array.isArray(value) ? value : []);
const cleanText = (value, max = MAX_TEXT) => String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);

function readJson(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return JSON.parse(text);
  } catch { return fallback; }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function readJsonl(file) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  fs.renameSync(tmp, file);
}

function normalizeTags(tags) {
  return asArray(tags).map((t) => String(t).trim().slice(0, 20)).filter(Boolean).slice(0, MAX_TAGS);
}

function normalizeDays(days) {
  return [...new Set(asArray(days).map((d) => String(d).trim()).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].slice(0, 30);
}

function normalizeIds(ids) {
  return [...new Set(asArray(ids).map((id) => String(id).trim()).filter(Boolean))].slice(0, 200);
}

export function normalizeSpaceEntry(input = {}, { id } = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const tier = SPACE_TIERS.includes(src.tier) ? src.tier : 'active';
  const kind = SPACE_KINDS.includes(src.kind) ? src.kind : 'fact';
  const status = SPACE_STATUSES.includes(src.status) ? src.status : 'active';
  const now = Date.now();
  const createdAt = Number(src.createdAt) || now;
  return {
    id: String(id || src.id || `mem_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`),
    space: String(src.space || DEFAULT_SPACE).trim().slice(0, 40) || DEFAULT_SPACE,
    kind,
    tier,
    status,
    text: cleanText(src.text),
    tags: normalizeTags(src.tags),
    importance: clampInt(src.importance, tier === 'core' ? 5 : 3, 1, 5),
    sourceDays: normalizeDays(src.sourceDays),
    sourceEventIds: normalizeIds(src.sourceEventIds),
    confidence: Math.min(1, Math.max(0, Number(src.confidence) || 0.5)),
    by: src.by === 'owner' ? 'owner' : (src.by === 'consolidator' ? 'consolidator' : 'agent'),
    createdAt,
    updatedAt: Number(src.updatedAt) || now,
    lastUsedAt: Number(src.lastUsedAt) || 0,
    useCount: Math.max(0, Math.round(Number(src.useCount) || 0)),
    deletedAt: src.deletedAt ? Number(src.deletedAt) : null,
    meta: src.meta && typeof src.meta === 'object' && !Array.isArray(src.meta) ? src.meta : {},
  };
}

export function createMemorySpace({ memoryDir, spaceDir, importantFile, kbFile, log = () => {} } = {}) {
  if (!memoryDir) throw new Error('memoryDir required');
  const root = String(spaceDir || path.join(memoryDir, 'space'));
  const entriesFile = path.join(root, 'entries.jsonl');
  const stateFile = path.join(root, 'state.json');
  const auditDir = path.join(root, 'audit');
  const importantPath = String(importantFile || path.join(memoryDir, 'important.jsonl'));
  const kbPath = String(kbFile || path.join(memoryDir, 'kb', 'entries.jsonl'));

  fs.mkdirSync(root, { recursive: true });

  function readEntries() {
    return readJsonl(entriesFile).map((r) => normalizeSpaceEntry(r, { id: r.id }));
  }

  function writeEntries(rows) {
    writeJsonl(entriesFile, rows);
  }

  function readState() {
    return readJson(stateFile, { version: 1, lastConsolidatedDay: '', lastConsolidatedAt: 0, migratedAt: 0 }) || {};
  }

  function writeState(patch = {}) {
    writeJson(stateFile, { ...readState(), ...patch, version: 1 });
  }

  function audit(day, record) {
    const file = path.join(auditDir, `${day || 'unknown'}.jsonl`);
    fs.mkdirSync(auditDir, { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ at: Date.now(), ...record })}\n`, 'utf8');
  }

  function get(id) {
    return readEntries().find((r) => r.id === id) || null;
  }

  function list({ tier = '', kind = '', space = '', status = 'active', includeDeleted = false, q = '', limit = 0 } = {}) {
    const query = String(q || '').trim().toLowerCase();
    let rows = readEntries().filter((r) => includeDeleted || !r.deletedAt);
    if (tier) rows = rows.filter((r) => r.tier === tier);
    if (kind) rows = rows.filter((r) => r.kind === kind);
    if (space) rows = rows.filter((r) => r.space === space);
    if (status) rows = rows.filter((r) => r.status === status);
    if (query) {
      rows = rows.filter((r) => `${r.text} ${r.tags.join(' ')} ${r.kind} ${r.space}`.toLowerCase().includes(query));
    }
    rows.sort((a, b) => {
      const tierRank = { core: 0, active: 1, knowledge: 2 };
      return (tierRank[a.tier] - tierRank[b.tier])
        || (b.importance - a.importance)
        || (b.updatedAt - a.updatedAt);
    });
    return limit > 0 ? rows.slice(0, limit) : rows;
  }

  function add(input) {
    const entry = normalizeSpaceEntry(input);
    if (!entry.text) throw new Error('text 不能为空');
    const rows = readEntries();
    const pos = rows.findIndex((r) => r.id === entry.id);
    if (pos >= 0) rows[pos] = entry;
    else rows.push(entry);
    writeEntries(rows);
    return entry;
  }

  function update(id, patch = {}) {
    const rows = readEntries();
    const idx = rows.findIndex((r) => r.id === id);
    if (idx < 0) return null;
    const next = normalizeSpaceEntry({ ...rows[idx], ...patch, id, updatedAt: Date.now() }, { id });
    rows[idx] = next;
    writeEntries(rows);
    return next;
  }

  function softDelete(id, by = 'owner') {
    const item = update(id, { deletedAt: Date.now(), by });
    return item;
  }

  function restore(id) {
    return update(id, { deletedAt: null });
  }

  function hardDelete(id) {
    const rows = readEntries();
    const next = rows.filter((r) => r.id !== id);
    if (next.length === rows.length) return null;
    writeEntries(next);
    return { id, deleted: true };
  }

  function markUsed(ids) {
    const wanted = new Set(asArray(ids).map(String));
    if (!wanted.size) return 0;
    const rows = readEntries();
    let changed = 0;
    for (const r of rows) {
      if (!wanted.has(r.id)) continue;
      r.useCount = Math.max(0, Number(r.useCount) || 0) + 1;
      r.lastUsedAt = Date.now();
      changed += 1;
    }
    if (changed) writeEntries(rows);
    return changed;
  }

  /** core 全量注入：不过滤、不截断（提示词要求 core 保持少而硬）。 */
  function coreBlock() {
    const rows = list({ tier: 'core', limit: 0 });
    if (!rows.length) return '';
    const lines = rows.map((r) => {
      const tags = r.tags.length ? `（${r.tags.join('/')}）` : '';
      return `- ${String(r.text).replace(/\s+/g, ' ').trim()}${tags}`;
    });
    return `【核心记忆】\n${lines.join('\n')}`;
  }

  /** active 选择性注入：按重要性、新近度、使用次数取 top。 */
  function activeBlock({ maxChars = 500, limit = 8, now = Date.now() } = {}) {
    // 迁移进来的旧 important 质量参差：先留在空间里可见，但不自动注入；
    // 由主人/整理器决定升 core 或改成 active。
    const rows = list({ tier: 'active', limit: 0 }).filter((r) => r.space !== 'legacy');
    const scored = rows.map((r) => {
      const ageDays = Math.max(0, (now - (r.updatedAt || r.createdAt)) / 86400000);
      return {
        r,
        score: r.importance * 0.55
          + Math.exp(-ageDays / 90) * 0.25
          + Math.min(0.2, (r.useCount || 0) * 0.01),
      };
    }).sort((a, b) => b.score - a.score);
    const lines = [];
    let used = 0;
    for (const { r } of scored) {
      const line = `- ${String(r.text).replace(/\s+/g, ' ').slice(0, 160)}`;
      if (used + line.length > maxChars) break;
      lines.push(line);
      used += line.length + 1;
      if (lines.length >= limit) break;
    }
    return lines.length ? `【主动记忆】\n${lines.join('\n')}` : '';
  }

  function knowledgeEntries() {
    return list({ tier: 'knowledge', limit: 0 });
  }

  /** 把知识条目还原成 KB 工具/UI 认的形状（兼容旧 meta.kb）。 */
  function kbEntryFromSpace(entry) {
    const kb = entry?.meta?.legacyKb && typeof entry.meta.legacyKb === 'object' ? entry.meta.legacyKb : {};
    const lines = String(entry?.text || '').split('\n');
    const meaningLine = lines.find((l) => l.startsWith('含义：'));
    const usageLine = lines.find((l) => l.startsWith('用法：'));
    const exampleLine = lines.find((l) => l.startsWith('例：'));
    const examples = kb.examples?.length
      ? kb.examples
      : (exampleLine ? exampleLine.replace(/^例：/, '').split('；').map((x) => x.trim()).filter(Boolean) : []);
    return {
      id: String(kb.id || entry?.meta?.kbId || entry?.id || '').replace(/^kb_/, ''),
      kind: SPACE_KINDS.includes(entry?.kind) ? entry.kind : 'other',
      term: String(kb.term || lines[0] || '').slice(0, 60),
      meaning: String(kb.meaning || (meaningLine ? meaningLine.slice(3) : '')).slice(0, 500),
      usage: String(kb.usage || (usageLine ? usageLine.slice(3) : '')).slice(0, 300),
      examples,
      tags: normalizeTags(kb.tags || entry?.tags),
      source: String(kb.source || 'space').slice(0, 40),
      at: kb.at || new Date(entry?.createdAt || Date.now()).toISOString(),
      updatedAt: kb.updatedAt || new Date(entry?.updatedAt || entry?.createdAt || Date.now()).toISOString(),
    };
  }

  /** KB 写入落到记忆空间（不再单独维护一份 entries.jsonl）。 */
  function upsertKb(input = {}) {
    const kbId = String(input.id || '').trim();
    const all = list({ tier: 'knowledge', includeDeleted: true, limit: 0 });
    const existing = kbId
      ? all.find((r) => String(r.meta?.legacyKb?.id || r.meta?.kbId || r.id).replace(/^kb_/, '') === kbId)
      : null;
    const id = existing?.id || `kb_${kbId || Date.now().toString(36)}`;
    const text = [
      String(input.term || '').trim(),
      input.meaning ? `含义：${String(input.meaning).trim()}` : '',
      input.usage ? `用法：${String(input.usage).trim()}` : '',
      asArray(input.examples).length ? `例：${asArray(input.examples).map((x) => String(x).trim()).join('；')}` : '',
    ].filter(Boolean).join('\n');
    if (!String(input.term || '').trim()) throw new Error('term 不能为空');
    const entry = add({
      ...(existing || {}),
      id,
      space: 'knowledge',
      kind: SPACE_KINDS.includes(input.kind) ? input.kind : 'other',
      tier: 'knowledge',
      status: 'active',
      text,
      tags: input.tags,
      importance: 3,
      by: 'owner',
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now(),
      deletedAt: null,
      meta: {
        ...(existing?.meta || {}),
        kbId: kbId || id.replace(/^kb_/, ''),
        legacyKb: {
          id: kbId || id.replace(/^kb_/, ''),
          kind: input.kind || 'other',
          term: String(input.term || '').trim().slice(0, 60),
          meaning: String(input.meaning || '').trim().slice(0, 500),
          usage: String(input.usage || '').trim().slice(0, 300),
          examples: asArray(input.examples).map((x) => String(x).slice(0, 200)).slice(0, 5),
          tags: normalizeTags(input.tags),
          source: String(input.source || 'manual').slice(0, 40),
          at: existing?.meta?.legacyKb?.at || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    });
    return kbEntryFromSpace(entry);
  }

  function removeKb(id) {
    const wanted = String(id || '').replace(/^kb_/, '');
    const rows = list({ tier: 'knowledge', includeDeleted: true, limit: 0 });
    const hit = rows.find((r) => String(r.meta?.legacyKb?.id || r.meta?.kbId || r.id).replace(/^kb_/, '') === wanted);
    if (!hit) return false;
    hardDelete(hit.id);
    return true;
  }

  function searchUnits() {
    return list({ status: 'active', limit: 0 }).map((r) => ({
      id: `space:${r.id}`,
      kind: `space:${r.tier}`,
      space: r.space,
      day: r.sourceDays[0] || '',
      text: r.text,
      at: r.updatedAt || r.createdAt,
      importance: r.importance,
    }));
  }

  function stats() {
    const rows = readEntries();
    const live = rows.filter((r) => !r.deletedAt);
    return {
      total: rows.length,
      live: live.length,
      core: live.filter((r) => r.tier === 'core').length,
      active: live.filter((r) => r.tier === 'active').length,
      knowledge: live.filter((r) => r.tier === 'knowledge').length,
      draft: live.filter((r) => r.status === 'draft').length,
      legacyImportant: live.filter((r) => r.meta?.legacyImportant).length,
      deleted: rows.filter((r) => r.deletedAt).length,
      spaces: [...new Set(live.map((r) => r.space))],
      lastConsolidatedDay: readState().lastConsolidatedDay || '',
      lastConsolidatedAt: readState().lastConsolidatedAt || 0,
    };
  }

  /** 迁移 important.jsonl：保留原 id / 时间 / importance，统一成 core。 */
  function migrateImportant({ force = false } = {}) {
    const legacyFile = importantPath;
    const legacy = readJsonl(legacyFile);
    if (!legacy.length) return { ok: true, imported: 0, skipped: 0, total: 0 };
    const rows = readEntries();
    const byId = new Map(rows.map((r) => [r.id, r]));
    let imported = 0;
    let skipped = 0;
    for (const old of legacy) {
      const id = String(old.id || '').trim();
      if (!id || !String(old.text || '').trim()) { skipped += 1; continue; }
      if (byId.has(id) && !force) { skipped += 1; continue; }
      const entry = normalizeSpaceEntry({
        id,
        space: 'legacy',
        kind: 'fact',
        tier: 'active', // 旧 important 质量参差；先进入 active，由整理器/主人决定是否升 core
        status: 'active',
        text: old.text,
        tags: old.tags,
        importance: old.importance || 3,
        by: old.by === 'owner' ? 'owner' : 'agent',
        createdAt: old.createdAt,
        updatedAt: old.updatedAt || old.createdAt,
        deletedAt: old.deletedAt || null,
        sourceDays: [],
        sourceEventIds: [],
        meta: { legacyImportant: true, legacyImportance: old.importance || 3, source: old.source || '' },
      }, { id });
      const pos = rows.findIndex((r) => r.id === id);
      if (pos >= 0) rows[pos] = entry; else rows.push(entry);
      imported += 1;
    }
    if (imported) writeEntries(rows);
    writeState({ migratedAt: Date.now() });
    return { ok: true, imported, skipped, total: legacy.length };
  }

  /** 迁移 kb/entries.jsonl：统一成 knowledge 条目，保留原始字段到 meta.kb。 */
  function migrateKb({ force = false } = {}) {
    const legacy = readJsonl(kbPath);
    if (!legacy.length) return { ok: true, imported: 0, skipped: 0, total: 0 };
    const rows = readEntries();
    const byId = new Map(rows.map((r) => [r.id, r]));
    let imported = 0;
    let skipped = 0;
    for (const old of legacy) {
      const kbId = String(old.id || '').trim();
      const term = String(old.term || '').trim();
      if (!kbId || !term) { skipped += 1; continue; }
      const id = `kb_${kbId}`;
      if (byId.has(id) && !force) { skipped += 1; continue; }
      const text = [
        term,
        old.meaning ? `含义：${old.meaning}` : '',
        old.usage ? `用法：${old.usage}` : '',
        asArray(old.examples).length ? `例：${asArray(old.examples).join('；')}` : '',
      ].filter(Boolean).join('\n');
      const entry = normalizeSpaceEntry({
        id,
        space: 'knowledge',
        kind: old.kind || 'other',
        tier: 'knowledge',
        status: 'active',
        text,
        tags: old.tags,
        importance: 3,
        by: 'owner',
        createdAt: Date.parse(old.at || '') || Date.now(),
        updatedAt: Date.parse(old.updatedAt || old.at || '') || Date.now(),
        sourceDays: [],
        sourceEventIds: [],
        meta: { legacyKb: old, kbId },
      }, { id });
      rows.push(entry);
      imported += 1;
    }
    if (imported) writeEntries(rows);
    return { ok: true, imported, skipped, total: legacy.length };
  }

  return {
    root, entriesFile, stateFile, auditDir, importantPath, kbPath,
    readEntries, readState, writeState, audit,
    get, list, add, update, softDelete, restore, hardDelete, markUsed,
    coreBlock, activeBlock, knowledgeEntries, searchUnits, stats,
    kbEntryFromSpace, upsertKb, removeKb,
    migrateImportant, migrateKb,
  };
}
