/**
 * 记忆服务：复用现有 memory-space（core / active / knowledge）。
 *
 * 数据位置保持兼容：
 *   characters/<id>/memory-v2/space/entries.jsonl  （角色包）
 *   memory-v2/space/entries.jsonl                 （无角色时 Core 独立根）
 *   characters/<id>/memory/space/entries.jsonl    （仅历史布局回退）
 *
 * 只做薄封装，不重写格式；后续再把实现迁进 core。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createMemorySpace } from '../adapters/fs/memory-space.js';

function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function safeLimit(value, fallback = 20, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.round(n));
}

export function createMemoryService({ paths, persona, logger = () => {} }) {
  let cached = null;
  let cachedKey = '';

  function resolveDirs() {
    const cur = persona?.current?.();
    const base = cur ? path.join(paths.charactersDir, cur.id) : paths.home;
    const memoryDir = path.join(base, 'memory');
    const v2Space = path.join(base, 'memory-v2', 'space');
    const legacySpace = path.join(memoryDir, 'space');
    return {
      characterId: cur?.id || '',
      base,
      memoryDir,
      // 新数据统一写 memory-v2/space；只有已有角色包且历史布局没有 v2 时才回退旧 space。
      spaceDir: cur && !exists(v2Space) ? legacySpace : v2Space,
      kbFile: path.join(memoryDir, 'kb', 'entries.jsonl'),
    };
  }

  function space() {
    const dirs = resolveDirs();
    const key = `${dirs.memoryDir}|${dirs.spaceDir}`;
    if (cached && cachedKey === key) return cached;
    cached = createMemorySpace({
      memoryDir: dirs.memoryDir,
      spaceDir: dirs.spaceDir,
      kbFile: dirs.kbFile,
      log: (...args) => logger('[memory]', ...args),
    });
    cachedKey = key;
    return cached;
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
    const entry = space().add({
      ...input,
      tier,
      importance: tier === 'core' ? 5 : input.importance,
      by: input.by === 'owner' ? 'owner' : 'agent',
    });
    return entry;
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
