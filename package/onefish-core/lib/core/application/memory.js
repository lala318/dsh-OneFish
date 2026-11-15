/**
 * 记忆用例：memory-space（core / active / knowledge）的领域门面。
 *
 * 存储位置和文件布局由 adapters/fs/memory-store 负责；这里只做规则和排序。
 */
import { memoryScore, retentionOf } from '../domain/memory-score.js';

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

  function search(query = '', { tier = '', k = 8 } = {}) {
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
        try { vectorHits = vector.search(q, { k: Math.max(limit * 2, 12) }); } catch (error) {
          logger(`记忆向量检索失败：${error?.message ?? error}`);
        }
      }
    }
    const byId = new Map();
    for (const row of rows) {
      byId.set(row.id, {
        id: row.id,
        tier: row.tier,
        kind: row.kind,
        text: row.text,
        tags: row.tags,
        importance: row.importance,
        updatedAt: row.updatedAt,
        retention: retentionOf(row),
        score: memoryScore(row),
        source: 'lexical',
      });
    }
    for (const hit of vectorHits) {
      if (tier && hit.tier !== tier) continue;
      const current = byId.get(hit.id);
      if (!current) {
        byId.set(hit.id, {
          id: hit.id,
          tier: hit.tier,
          kind: hit.kind,
          text: hit.text,
          tags: [],
          importance: hit.importance,
          updatedAt: hit.at,
          retention: hit.retention,
          score: hit.score,
          source: 'vector',
        });
      } else {
        current.score = Math.max(current.score, hit.score);
        current.source = 'hybrid';
        current.retention = Math.max(current.retention || 0, hit.retention || 0);
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

  function maintain({ day = '', now = Date.now() } = {}) {
    const s = space();
    const decayed = s.applyDecay({ now });
    const deduped = s.dedupe({ now });
    const vector = vectorFor(s);
    const indexed = vector ? vector.build({ force: true, now }) : { total: 0, computed: 0, reused: 0 };
    const result = { ok: true, day, now, decayed, deduped, indexed };
    s.writeState({ lastMaintainedDay: day, lastMaintainedAt: now });
    s.audit(day || 'maintenance', { op: 'maintain', ...result });
    logger(`记忆维护：衰减 ${decayed.changed} / 休眠 ${decayed.dormant} / 去重 ${deduped.merged} / 向量 ${indexed.total}`);
    return result;
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
        dir: resolveDirs().spaceDir,
        vector: s.vector,
      };
    } catch (error) {
      return { error: String(error?.message ?? error) };
    }
  }

  return { resolveDirs, search, add, update, remove, list, stats, blocks, health, maintain };
}
