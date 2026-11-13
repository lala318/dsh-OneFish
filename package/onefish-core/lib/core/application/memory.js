/**
 * 记忆用例：memory-space（core / active / knowledge）的领域门面。
 *
 * 存储位置和文件布局由 adapters/fs/memory-store 负责；这里只做规则和排序。
 */
function safeLimit(value, fallback = 20, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.round(n));
}

export function createMemoryService({ store, persona, logger = () => {} } = {}) {
  if (!store) throw new Error('memory store is required');

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
    let rows = space().list({ tier, q, limit });
    // 中文/短语按整段匹配可能一条都命中不了；退回按词（空格/标点）OR 匹配。
    if (!rows.length && q) {
      const terms = q.split(/[\s,，。;；/、|]+/).map((term) => term.trim()).filter(Boolean);
      if (terms.length) {
        rows = space().list({ tier, limit: 1000 })
          .filter((row) => terms.some((term) => row.text.includes(term) || row.tags.some((tag) => tag.includes(term))))
          .slice(0, limit);
      }
    }
    return rows.map((row) => ({
      id: row.id,
      tier: row.tier,
      kind: row.kind,
      text: row.text,
      tags: row.tags,
      importance: row.importance,
      updatedAt: row.updatedAt,
    }));
  }

  function add(input = {}) {
    const tier = input.tier === 'core' || input.tier === 'knowledge' ? input.tier : 'active';
    return space().add({
      ...input,
      tier,
      importance: tier === 'core' ? 5 : input.importance,
      by: input.by === 'owner' ? 'owner' : 'agent',
    });
  }

  function update(id, patch = {}) {
    return space().update(String(id || ''), {
      ...patch,
      ...(patch.tier === 'core' ? { importance: 5 } : {}),
    });
  }

  function remove(id) {
    return space().softDelete(String(id || ''), 'owner');
  }

  function list({ tier = '', q = '', limit = 30, includeDeleted = false } = {}) {
    return space().list({
      tier,
      q,
      includeDeleted,
      limit: safeLimit(limit, 30, 100),
    });
  }

  function stats() {
    return space().stats();
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
        dir: resolveDirs().spaceDir,
      };
    } catch (error) {
      return { error: String(error?.message ?? error) };
    }
  }

  return { resolveDirs, search, add, update, remove, list, stats, blocks, health };
}
