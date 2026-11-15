/**
 * 记忆向量索引（本地）：entries.jsonl -> vectors/index.jsonl。
 *
 * 索引单元 = 当前角色的全部记忆条目；按 textHash 增量复用向量。
 */
import fs from 'node:fs';
import path from 'node:path';
import { embedText, cosine, encodeVector, decodeVector, textHash } from '../../domain/vector.js';
import { memoryScore, retentionOf } from '../../domain/memory-score.js';

const INDEX_VERSION = 1;
const MODEL = 'local-hash-256';

export function createMemoryVectorIndex({ space, logger = () => {} } = {}) {
  if (!space) throw new Error('memory space is required');
  const file = path.join(space.root, 'vectors', 'index.jsonl');
  let cache = null;

  function readIndex() {
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return { meta: null, entries: [] }; }
    let meta = null;
    const entries = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row.type === 'meta') meta = row;
        else if (row.id && row.vec) entries.push({ ...row, vector: decodeVector(row.vec) });
      } catch {}
    }
    return { meta, entries };
  }

  function unitList(now = Date.now()) {
    return space.list({ limit: 0, includeDeleted: false })
      .filter((entry) => entry.status === 'active' && String(entry.text || '').trim())
      .map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        tier: entry.tier,
        day: entry.sourceDays?.[0] || '',
        text: entry.text,
        at: entry.updatedAt || entry.createdAt,
        importance: entry.importance,
        retention: retentionOf(entry, { now }),
        score: memoryScore(entry, { now }),
      }));
  }

  function writeIndex(entries, now = Date.now()) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    const meta = {
      type: 'meta',
      version: INDEX_VERSION,
      model: MODEL,
      dim: entries[0]?.vec ? decodeVector(entries[0].vec).length : 0,
      builtAt: now,
      count: entries.length,
    };
    const body = [JSON.stringify(meta), ...entries.map((entry) => JSON.stringify(entry))].join('\n');
    fs.writeFileSync(tmp, `${body}\n`, 'utf8');
    fs.renameSync(tmp, file);
  }

  function build({ force = false, now = Date.now() } = {}) {
    const units = unitList(now);
    const existing = force ? { entries: [] } : readIndex();
    const byId = new Map(existing.entries.map((entry) => [entry.id, entry]));
    let computed = 0;
    let reused = 0;
    const rows = [];
    for (const unit of units) {
      const hash = textHash(unit.text);
      const old = byId.get(unit.id);
      if (!force && old && old.textHash === hash) {
        const { vector: _vector, ...rest } = old;
        rows.push({ ...rest, imp: unit.importance, at: unit.at, retention: unit.retention });
        reused += 1;
        continue;
      }
      rows.push({
        id: unit.id,
        kind: unit.kind,
        tier: unit.tier,
        day: unit.day,
        text: String(unit.text).slice(0, 300),
        textHash: hash,
        at: unit.at,
        imp: unit.importance,
        retention: unit.retention,
        vec: encodeVector(embedText(unit.text)),
      });
      computed += 1;
    }
    writeIndex(rows, now);
    cache = { signature: signatureOf(units), rows, indexes: rows.map((row) => ({ ...row, vector: decodeVector(row.vec) })), builtAt: now };
    logger(`记忆向量索引：${rows.length} 条（新算 ${computed} / 复用 ${reused}）`);
    return { total: rows.length, computed, reused };
  }

  function signatureOf(units) {
    return units.map((unit) => `${unit.id}:${unit.at}:${unit.importance}`).join('|');
  }

  function ensure(now = Date.now()) {
    const units = unitList(now);
    const signature = signatureOf(units);
    if (cache && cache.signature === signature) return cache;
    const loaded = readIndex();
    if (loaded.entries.length && loaded.meta?.model === MODEL && loaded.entries.length === units.length
      && units.every((unit) => loaded.entries.some((entry) => entry.id === unit.id))) {
      const byId = new Map(loaded.entries.map((entry) => [entry.id, entry]));
      const rows = units.map((unit) => ({ ...byId.get(unit.id), imp: unit.importance, at: unit.at, retention: unit.retention })).filter((row) => row.id);
      cache = { signature, rows, indexes: rows.map((row) => ({ ...row, vector: row.vector })), builtAt: loaded.meta.builtAt };
      return cache;
    }
    build({ now });
    return cache;
  }

  function search(query, { k = 8, now = Date.now() } = {}) {
    const text = String(query || '').trim();
    if (!text) return [];
    const index = ensure(now);
    const vector = embedText(text);
    const scored = [];
    for (const row of index.indexes) {
      const cos = cosine(vector, row.vector);
      if (cos < 0.18) continue;
      const score = 0.72 * cos
        + 0.16 * Math.min(1, (Number(row.imp) || 0) / 5)
        + 0.12 * Math.min(1, Number(row.retention) || 0);
      scored.push({
        id: row.id,
        kind: row.kind,
        tier: row.tier,
        day: row.day,
        text: row.text,
        cos,
        score,
        importance: row.imp,
        retention: row.retention,
        at: row.at,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(1, Math.min(20, Number(k) || 8)));
  }

  function stats() {
    const index = readIndex();
    return { file, model: index.meta?.model || MODEL, count: index.entries.length, dim: index.meta?.dim || 0, builtAt: index.meta?.builtAt || 0 };
  }

  function invalidate() {
    cache = null;
  }

  return { file, build, ensure, search, stats, invalidate, model: MODEL };
}
