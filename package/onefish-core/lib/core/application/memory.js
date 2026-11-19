/**
 * 记忆用例：memory-space（core / active / knowledge）的领域门面。
 *
 * 存储位置和文件布局由 adapters/fs/memory-store 负责；这里只做规则和排序。
 */
import { memoryScore, retentionOf } from '../domain/memory-score.js';
import {
  buildConsolidatePrompt,
  parseConsolidateOutput,
  validateConsolidateOps,
  applyConsolidateOps,
} from './memory-consolidate.js';

function safeLimit(value, fallback = 20, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.round(n));
}

export function createMemoryService({ store, persona, logger = () => {}, vectorFactory = null } = {}) {
  if (!store) throw new Error('memory store is required');
  const vectors = new Map();

  function vectorFor(s) {
    if (!vectorFactory) return null;
    let index = vectors.get(s.root);
    if (!index) {
      index = vectorFactory(s);
      vectors.set(s.root, index);
    }
    return index;
  }

  function resolveDirs() {
    const cur = persona?.current?.();
    return store.describe(cur?.id || '');
  }

  function space() {
    const cur = persona?.current?.();
    return store.getSpace(cur?.id || '').space;
  }

  async function search(query = '', { tier = '', k = 8 } = {}) {
    const q = String(query ?? '').trim();
    const limit = safeLimit(k, 8, 30);
    const s = space();
    let rows = s.list({ tier, q, limit });
    // 中文/短语按整段匹配可能一条都命中不了；退回按词（空格/标点）OR 匹配。
    if (!rows.length && q) {
      const terms = q.split(/[\s,，。;；/、|]+/).map((term) => term.trim()).filter(Boolean);
      if (terms.length) {
        rows = s.list({ tier, limit: 1000 })
          .filter((row) => terms.some((term) => row.text.includes(term) || row.tags.some((tag) => tag.includes(term))))
          .slice(0, limit);
      }
    }
    let vectorHits = [];
    if (q) {
      const vector = vectorFor(s);
      if (vector) {
        try { vectorHits = await vector.search(q, { k: Math.max(limit * 2, 12) }); } catch (error) {
          logger(`记忆向量检索失败：${error?.message ?? error}`);
        }
      }
    }
    // relevance only gates candidates; ranking blends relevance with memoryScore.
    const terms = q.split(/[^\p{L}\p{N}]+/u).map((term) => term.trim()).filter(Boolean);
    const byId = new Map();
    const relevanceOf = (row) => {
      if (!terms.length) return 0;
      const haystack = `${row.text} ${(row.tags || []).join(' ')}`;
      const matched = terms.filter((term) => haystack.includes(term)).length;
      return matched / terms.length;
    };
    const addCandidate = (row, relevance, source) => {
      const current = byId.get(row.id);
      const next = Math.max(current?.relevance || 0, relevance);
      byId.set(row.id, {
        id: row.id,
        tier: row.tier,
        kind: row.kind,
        text: row.text,
        tags: row.tags || [],
        importance: row.importance,
        updatedAt: row.updatedAt,
        retention: retentionOf(row),
        relevance: next,
        score: 0.6 * next + 0.4 * memoryScore(row),
        source: current && current.source !== source ? 'hybrid' : source,
      });
    };
    for (const row of rows) addCandidate(row, relevanceOf(row), 'lexical');
    if (vectorHits.length) {
      const entriesById = new Map(s.list({ tier, limit: 0 }).map((row) => [row.id, row]));
      for (const hit of vectorHits) {
        if (tier && hit.tier !== tier) continue;
        const row = entriesById.get(hit.id);
        if (row) addCandidate(row, Number(hit.cos) || 0, 'vector');
      }
    }
    return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  function add(input = {}) {
    const tier = input.tier === 'core' || input.tier === 'knowledge' ? input.tier : 'active';
    const result = space().add({
      ...input,
      tier,
      importance: tier === 'core' ? 5 : input.importance,
      by: input.by === 'owner' ? 'owner' : 'agent',
    });
    vectorFor(space())?.invalidate();
    return result;
  }

  function update(id, patch = {}) {
    const result = space().update(String(id || ''), {
      ...patch,
      ...(patch.tier === 'core' ? { importance: 5 } : {}),
    });
    if (result) vectorFor(space())?.invalidate();
    return result;
  }

  function remove(id) {
    const result = space().softDelete(String(id || ''), 'owner');
    if (result) vectorFor(space())?.invalidate();
    return result;
  }

  /** 用一条新事实替代旧事实：旧条目保留但不再注入/检索。 */
  function supersede(id, patch = {}) {
    const s = space();
    const old = s.get(String(id || ''));
    if (!old) return null;
    const text = String(patch.text || '').trim();
    if (!text) throw new Error('supersede text is required');
    const replacement = s.add({
      ...patch,
      text,
      tier: patch.tier || old.tier,
      kind: patch.kind || old.kind,
      tags: patch.tags || old.tags,
      by: 'consolidator',
      supersedes: [old.id],
      sourceDays: patch.sourceDays || old.sourceDays,
      confidence: patch.confidence ?? 0.8,
    });
    const superseded = s.update(old.id, {
      status: 'superseded',
      supersededBy: replacement.id,
      validTo: Date.now(),
      lastConfirmedAt: Date.now(),
    });
    vectorFor(s)?.invalidate();
    return { old: superseded, replacement };
  }

  function list({ tier = '', q = '', limit = 30, includeDeleted = false } = {}) {
    return space().list({
      tier,
      q,
      includeDeleted,
      limit: safeLimit(limit, 30, 100),
    }).map((row) => ({
      ...row,
      retention: retentionOf(row),
      score: memoryScore(row),
    }));
  }

  /** 自动召回用的候选池：全部生效条目，不做截断（本地词面打分在 recall 服务里）。 */
  function recallCandidates({ tier = '' } = {}) {
    return space().list({ tier, limit: 0 }).map((row) => ({
      ...row,
      retention: retentionOf(row),
      score: memoryScore(row),
    }));
  }

  async function maintain({ day = '', now = Date.now() } = {}) {
    const s = space();
    const decayed = s.applyDecay({ now });
    const deduped = s.dedupe({ now });
    const vector = vectorFor(s);
    const indexed = vector ? await vector.build({ force: true, now }) : { total: 0, computed: 0, reused: 0 };
    const result = { ok: true, day, now, decayed, deduped, indexed };
    s.writeState({ lastMaintainedDay: day, lastMaintainedAt: now });
    s.audit(day || 'maintenance', { op: 'maintain', ...result });
    logger(`记忆维护：衰减 ${decayed.changed} / 休眠 ${decayed.dormant} / 去重 ${deduped.merged} / 向量 ${indexed.total}`);
    return result;
  }

  function consolidationPrompt({ day = '', digest = '', events = [] } = {}) {
    const s = space();
    return buildConsolidatePrompt({
      day,
      digest,
      events,
      core: s.list({ tier: 'core', limit: 0 }),
      active: s.list({ tier: 'active', limit: 0 }),
      knowledge: s.list({ tier: 'knowledge', limit: 0 }),
    });
  }

  function applyConsolidation({ day = '', ops = null, text = '' } = {}) {
    const s = space();
    const parsed = Array.isArray(ops) ? ops : parseConsolidateOutput(text);
    const checked = validateConsolidateOps(parsed, { space: s, day });
    if (!checked.ok) return { ok: false, errors: checked.errors, applied: [], skipped: [] };
    const result = applyConsolidateOps(s, checked.ops, { day });
    if (result.applied.length) vectorFor(s)?.invalidate();
    return { ok: true, errors: [], ...result };
  }

  async function consolidate({ day = '', digest = '', events = [], complete = null } = {}) {
    if (typeof complete !== 'function') throw new Error('memory.consolidate requires complete(prompt)');
    const prompt = consolidationPrompt({ day, digest, events });
    const answer = await complete(prompt);
    const applied = applyConsolidation({ day, text: answer });
    logger(`模型记忆整理：${day} 应用 ${applied.applied.length} / 跳过 ${applied.skipped.length}`);
    return { ...applied, prompt, answer };
  }

  function stats() {
    const s = space();
    const vector = vectorFor(s);
    return { ...s.stats(), vector: vector ? vector.stats() : null };
  }

  function blocks() {
    const s = space();
    return {
      core: s.coreBlock(),
      active: s.activeBlock({ maxChars: 500, limit: 8 }),
    };
  }

  function health() {
    try {
      const s = stats();
      return {
        total: s.live,
        core: s.core,
        active: s.active,
        knowledge: s.knowledge,
        dormant: s.dormant,
        superseded: s.superseded,
        dir: resolveDirs().spaceDir,
        vector: s.vector,
      };
    } catch (error) {
      return { error: String(error?.message ?? error) };
    }
  }

  return {
    resolveDirs, search, add, update, remove, supersede, list, recallCandidates, stats, blocks, health, maintain,
    consolidationPrompt, applyConsolidation, consolidate,
  };
}
