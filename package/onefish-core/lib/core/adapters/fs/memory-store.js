/**
 * Memory 存储适配器。
 *
 * 负责选择 memory-v2/space / 旧 space 布局，并把 memory-space 实例交给应用层。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createMemorySpace } from './memory-space.js';

function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

export function createMemoryStore({ paths, logger = () => {} }) {
  const cache = new Map();

  function describe(characterId = '') {
    const base = characterId
      ? path.join(paths.charactersDir, String(characterId))
      : paths.home;
    const memoryDir = path.join(base, 'memory');
    const v2Space = path.join(base, 'memory-v2', 'space');
    const legacySpace = path.join(memoryDir, 'space');
    return {
      characterId: String(characterId || ''),
      base,
      memoryDir,
      spaceDir: characterId && !exists(v2Space) ? legacySpace : v2Space,
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
