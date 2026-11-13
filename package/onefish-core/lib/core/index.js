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
import { createCorePaths, ensureCoreDirs } from './paths.js';
import { createPersonaService } from './persona.js';
import { createMemoryService } from './memory.js';
import { createSessionService } from './session.js';
import { createArchiveService } from './archive.js';
import { DEFAULT_CONFIG, loadConfig } from './config.js';

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
  const persona = createPersonaService({ paths, logger });
  const memory = createMemoryService({ paths, persona, logger });
  const archive = createArchiveService({ paths, logger });
  const session = createSessionService({
    paths,
    adapter: sessionAdapter,
    archive,
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

  return { paths, config, persona, memory, session, archive, health, log };
}

export { createCorePaths, resolveCoreHome } from './paths.js';
export { dayKeyOf, dayStart, dayEnd } from './day.js';
