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
import { createMemoryVectorIndex } from './adapters/fs/memory-vectors.js';
import { createEmbeddingProvider } from './adapters/embeddings/index.js';
import { createSessionIndexStore } from './adapters/fs/session-index.js';
import { createPersonaService } from './application/persona.js';
import { createMemoryService } from './application/memory.js';
import { createSessionService } from './application/session.js';
import { createArchiveService } from './adapters/fs/archive.js';
import { createComponentStore } from './adapters/fs/component-store.js';
import { createIdleStore } from './adapters/fs/idle-store.js';
import { createBootPackService } from './application/boot-pack.js';
import { createComponentRegistry } from './application/components.js';
import { createIdleClockService } from './application/idle.js';
import { DEFAULT_CONFIG } from './domain/config.js';
import { loadConfig } from './adapters/fs/config.js';

export function createCore({
  home = '',
  repoRoot = process.cwd(),
  logger = () => {},
  sessionAdapter = null,
  now = () => Date.now(),
  config: configOverride = {},
  idlePrompt = null,
  memoryConsolidator = null,
} = {}) {
  const paths = createCorePaths({ home, repoRoot });
  ensureCoreDirs(paths);

  const config = { ...DEFAULT_CONFIG, ...loadConfig(paths.configFile), ...configOverride };
  if (!config.workspacePath) config.workspacePath = paths.workspacePath;
  const personaStore = createPersonaStore({ paths });
  const memoryStore = createMemoryStore({ paths, logger });
  const embedding = createEmbeddingProvider({
    runtimeDir: config.embedding?.runtimeDir || '',
    modelDir: config.embedding?.modelDir || '',
    logger,
  });
  const sessionIndex = createSessionIndexStore({ paths });

  const persona = createPersonaService({ store: personaStore, logger });
  const memory = createMemoryService({
    store: memoryStore,
    persona,
    logger,
    vectorFactory: (space) => createMemoryVectorIndex({
      space,
      embedding,
      logger: (...args) => logger('[memory-vectors]', ...args),
    }),
  });
  const archive = createArchiveService({ paths, logger });
  const bootPack = createBootPackService({ persona, memory, archive, config, now });
  const session = createSessionService({
    sessionIndex,
    adapter: sessionAdapter,
    archive,
    bootPack,
    memoryMaintenance: ({ day }) => memory.maintain({ day }),
    memoryConsolidator,
    config,
    logger,
    now,
  });
  const idle = createIdleClockService({
    store: createIdleStore({ paths }),
    session: { current: () => session.current() },
    config,
    prompt: idlePrompt,
    logger,
    now,
  });
  const componentStore = createComponentStore({ paths });
  const components = createComponentRegistry({
    core: { session, persona, memory, bootPack, config },
    componentStore,
    version: '0.1.0',
    logger,
    config,
  });
  const componentApi = { apiVersion: 1, components };

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
      idle: idle.status(),
      embedding: embedding.status(),
      components: components.list(),
    };
  }

  function log(line) {
    try {
      fs.mkdirSync(paths.coreDir, { recursive: true });
      fs.appendFileSync(paths.pluginLog, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
    } catch {}
    try { logger(line); } catch {}
  }

  return { paths, config, persona, memory, session, archive, bootPack, idle, embedding, components, componentApi, health, log };
}

export { createCorePaths, resolveCoreHome } from './adapters/fs/paths.js';
export { dayKeyOf, dayStart, dayEnd } from './domain/day.js';
