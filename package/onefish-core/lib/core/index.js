/**
 * OneFish 最小核心入口。
 *
 * 只暴露三个服务：
 *   persona  人格
 *   memory   记忆
 *   session  统一会话
 *
 * 宿主（DSH 插件、MCP server）只通过这里访问核心，不直接碰文件。
 */
import fs from 'node:fs';
import { createCorePaths, ensureCoreDirs } from './paths.js';
import { createPersonaService } from './persona.js';
import { createMemoryService } from './memory.js';
import { createSessionService } from './session.js';

export function createCore({ home = '', repoRoot = process.cwd(), logger = () => {} } = {}) {
  const paths = createCorePaths({ home, repoRoot });
  ensureCoreDirs(paths);

  const persona = createPersonaService({ paths, logger });
  const memory = createMemoryService({ paths, persona, logger });
  const session = createSessionService({ paths, logger });

  function health() {
    return {
      ok: true,
      name: 'OneFish Core',
      version: '0.1.0',
      home: paths.home,
      persona: persona.health(),
      memory: memory.health(),
      session: session.stats(),
    };
  }

  function log(line) {
    try {
      fs.mkdirSync(paths.coreDir, { recursive: true });
      fs.appendFileSync(paths.pluginLog, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
    } catch {}
    try { logger(line); } catch {}
  }

  return { paths, persona, memory, session, health, log };
}

export { createCorePaths, resolveCoreHome } from './paths.js';
