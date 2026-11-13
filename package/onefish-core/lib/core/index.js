/**
 * OneFish 最小核心入口。
 *
 * 宿主（DSH 插件、MCP server）只通过这里访问核心，不直接碰文件。
 *
 * 职责：
 *   persona  人格
 *   memory   记忆
 *   session  日会话生命周期（会话运行时归 DSH）
 *   archive  全量档案
 */
import fs from 'node:fs';
import { createCorePaths, ensureCoreDirs } from './adapters/fs/paths.js';
import { createPersonaStore } from './adapters/fs/persona-store.js';
import { createMemoryStore } from './adapters/fs/memory-store.js';
import { createSessionIndexStore } from './adapters/fs/session-index.js';
import { createPersonaService } from './application/persona.js';
import { createMemoryService } from './application/memory.js';
import { createSessionService } from './application/session.js';
import { createArchiveService } from './adapters/fs/archive.js';
import { createBootPackService } from './application/boot-pack.js';
import { DEFAULT_CONFIG } from './domain/config.js';
import { loadConfig } from './adapters/fs/config.js';

export function createCore({
  home = '',
  repoRoot = process.cwd(),
  logger = () => {},
  sessionAdapter = null,
  now = () => Date.now(),
  config: configOverride = {},
} = {}) {
  const paths = createCorePaths({ home, repoRoot });
  ensureCoreDirs(paths);

  const config = { ...DEFAULT_CONFIG, ...loadConfig(paths.configFile), ...configOverride };
  if (!config.workspacePath) config.workspacePath = paths.workspacePath;
  const personaStore = createPersonaStore({ paths });
  const memoryStore = createMemoryStore({ paths, logger });
  const sessionIndex = createSessionIndexStore({ paths });

  const persona = createPersonaService({ store: personaStore, logger });
  const memory = createMemoryService({ store: memoryStore, persona, logger });
  const archive = createArchiveService({ paths, logger });
  const bootPack = createBootPackService({ persona, memory, archive, config, now });
  const session = createSessionService({
    sessionIndex,
    adapter: sessionAdapter,
    archive,
    bootPack,
    config,
    logger,
    now,
  });

  function health() {
    return {
      ok: true,
      name: 'OneFish Core',
      version: '0.1.0',
      home: paths.home,
      persona: persona.health(),
      memory: memory.health(),
      session: session.stats(),
      archive: { days: archive.listDays().length },
    };
  }

  function log(line) {
    try {
      fs.mkdirSync(paths.coreDir, { recursive: true });
      fs.appendFileSync(paths.pluginLog, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
    } catch {}
    try { logger(line); } catch {}
  }

  return { paths, config, persona, memory, session, archive, bootPack, health, log };
}

export { createCorePaths, resolveCoreHome } from './adapters/fs/paths.js';
export { dayKeyOf, dayStart, dayEnd } from './domain/day.js';
