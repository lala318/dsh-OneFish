/**
 * Memory 存储适配器。
 *
 * 负责选择记忆目录布局，并把 memory-space 实例交给应用层：
 *   - 新布局：`<角色>/memory/`（entries.jsonl / state.json / audit / vectors）
 *   - 旧布局：`<角色>/memory-v2/space/`（2026-11-22 之前）
 *   - 更旧布局：`<角色>/memory/space/`
 */
import fs from 'node:fs';
import path from 'node:path';
import { createMemorySpace } from './memory-space.js';

function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

/** 一个目录像不像记忆空间：有 entries.jsonl 或 state.json 就算。 */
function looksLikeSpace(dir) {
  return exists(path.join(dir, 'entries.jsonl')) || exists(path.join(dir, 'state.json'));
}

export function createMemoryStore({ paths, logger = () => {} }) {
  const cache = new Map();

  function describe(characterId = '') {
    const base = characterId
      ? path.join(paths.charactersDir, String(characterId))
      : paths.home;
    const memoryDir = path.join(base, 'memory');
    const legacyV2 = path.join(base, 'memory-v2', 'space');
    const legacyV1 = path.join(memoryDir, 'space');
    let spaceDir = memoryDir;
    if (!looksLikeSpace(memoryDir)) {
      if (looksLikeSpace(legacyV2)) spaceDir = legacyV2;
      else if (looksLikeSpace(legacyV1)) spaceDir = legacyV1;
    }
    return {
      characterId: String(characterId || ''),
      base,
      memoryDir,
      spaceDir,
      kbFile: path.join(memoryDir, 'kb', 'entries.jsonl'),
    };
  }

  function getSpace(characterId = '') {
    const dirs = describe(characterId);
    const key = `${dirs.memoryDir}|${dirs.spaceDir}`;
    let space = cache.get(key);
    if (!space) {
      space = createMemorySpace({
        memoryDir: dirs.memoryDir,
        spaceDir: dirs.spaceDir,
        kbFile: dirs.kbFile,
        log: (...args) => logger('[memory]', ...args),
      });
      cache.set(key, space);
    }
    return { space, dirs };
  }

  return { describe, getSpace };
}
