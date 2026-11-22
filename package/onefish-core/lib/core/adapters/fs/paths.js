/**
 * 核心路径解析。
 *
 * 原则：
 *   - 只在这里拼路径；
 *   - **数据根** `~/.dsh/onefish-data` 只放需要保留的东西（角色/人格、记忆、档案、配置、状态、日志、组件凭据）；
 *   - **缓存根** `~/.dsh/cache/onefish` 放可重装的依赖与模型（onnxruntime + bge），删了能重建；
 *   - 需要指向别处（迁移/测试）时显式设置 ONEFISH_CORE_HOME；
 *   - 不读配置、不碰业务。
 *
 * 历史：2026-11-22 之前数据根叫 `~/.dsh/onefish-core`，且 runtime 也塞在里面；
 * 现在拆开，旧目录不再识别（迁移脚本负责搬）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.USERPROFILE || os.homedir();
export const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh');

/** 数据根目录名（~/.dsh/onefish-data）。 */
export const DATA_DIR_NAME = 'onefish-data';
/** 缓存根目录名（~/.dsh/cache/onefish）。 */
export const CACHE_DIR_NAME = 'onefish';

function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

/** 核心数据根：显式覆盖 → 环境变量 → 默认 ~/.dsh/onefish-data。 */
export function resolveCoreHome(explicit = '') {
  const candidates = [
    String(explicit || '').trim(),
    String(process.env.ONEFISH_CORE_HOME || '').trim(),
    path.join(DSH_HOME, DATA_DIR_NAME),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (exists(dir)) return dir;
  }
  return path.join(DSH_HOME, DATA_DIR_NAME);
}

export function createCorePaths({ home = '', repoRoot = process.cwd() } = {}) {
  const coreHome = resolveCoreHome(home);
  const cacheHome = path.join(DSH_HOME, 'cache', CACHE_DIR_NAME);
  const charactersDir = path.join(coreHome, 'characters');
  const stateDir = path.join(coreHome, 'state');
  const logsDir = path.join(coreHome, 'logs');
  return {
    home: coreHome,
    cacheHome,
    repoRoot,
    charactersDir,
    currentCharacterFile: path.join(charactersDir, 'current.json'),
    configFile: path.join(coreHome, 'config.json'),
    /** 没有当前角色时兜底用的默认人格。 */
    fallbackPersona: path.join(coreHome, 'persona.md'),
    stateDir,
    sessionIndexFile: path.join(stateDir, 'session-index.json'),
    idleStateFile: path.join(stateDir, 'idle-clock.json'),
    logsDir,
    pluginLog: path.join(logsDir, 'plugin.log'),
    archiveDir: path.join(coreHome, 'archive'),
    archiveDaysDir: path.join(coreHome, 'archive', 'days'),
    archiveDigestsDir: path.join(coreHome, 'archive', 'digests'),
    componentsDir: path.join(coreHome, 'components'),
    /** 语义向量运行时（onnxruntime-node + bge 模型），可重装。 */
    embeddingRuntimeDir: path.join(cacheHome, 'runtime', 'onnx-embed'),
    // 日会话专用 DSH workspace；默认指向独立项目目录。
    workspacePath: path.join(DSH_HOME, 'OneFish'),
  };
}

export function ensureCoreDirs(paths) {
  for (const dir of [
    paths.home,
    paths.charactersDir,
    paths.stateDir,
    paths.logsDir,
    paths.archiveDir,
    paths.archiveDaysDir,
    paths.archiveDigestsDir,
    paths.componentsDir,
  ]) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  }
}
