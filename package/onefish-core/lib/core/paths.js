/**
 * 核心路径解析。
 *
 * 原则：
 *   - 只在这里拼路径；
 *   - Core 默认使用**独立数据根** `~/.dsh/onefish-core`，不读取旧 SurfCore 数据；
 *   - 需要指向别处（迁移/测试）时显式设置 ONEFISH_CORE_HOME；
 *   - 不读配置、不碰业务。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.USERPROFILE || os.homedir();
export const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh');

function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

/** 核心数据根：显式覆盖 → 环境变量 → 默认独立目录（不继承旧数据）。 */
export function resolveCoreHome(explicit = '') {
  const candidates = [
    String(explicit || '').trim(),
    String(process.env.ONEFISH_CORE_HOME || '').trim(),
    path.join(DSH_HOME, 'onefish-core'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (exists(dir)) return dir;
  }
  return path.join(DSH_HOME, 'onefish-core');
}

export function createCorePaths({ home = '', repoRoot = process.cwd() } = {}) {
  const coreHome = resolveCoreHome(home);
  return {
    home: coreHome,
    repoRoot,
    charactersDir: path.join(coreHome, 'characters'),
    currentCharacterFile: path.join(coreHome, 'characters', 'current.json'),
    coreDir: path.join(coreHome, 'core'),
    sessionsFile: path.join(coreHome, 'core', 'sessions.json'),
    pluginLog: path.join(coreHome, 'core', 'plugin.log'),
    fallbackPersona: path.join(coreHome, 'core', 'persona.md'),
  };
}

export function ensureCoreDirs(paths) {
  for (const dir of [paths.home, paths.coreDir, paths.charactersDir]) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  }
}
