/**
 * OneFish Core —— DSH 宿主半边（MVP）。
 *
 * 只做三件事：
 *   1. 启动核心服务（人格 / 记忆 / 日会话生命周期）；
 *   2. 暴露最小设置页 API；
 *   3. 订阅 DSH 会话事件，更新日会话活跃时间。
 *
 * 不加载具体频道组件；那些以后作为可选组件接入。
 */
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createCore } from './core/index.js';
import { DEFAULT_CONFIG, normalizeConfig } from './core/index.js';
import { createDshSessionAdapter } from './core/adapters/dsh/session-adapter.js';
import { createDshCompletion } from './core/adapters/dsh/completion.js';
import { createDshComponentBroker } from './core/adapters/dsh/component-broker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const API_PREFIX = '/dsh-onefish-core/api';
const VERSION = '0.1.0';

export const name = 'onefish-core';
export const inject = ['webServer', 'connection', 'sessionController'];

/**
 * DSH 0.2.x 的 sessionController.prompt(request, signal) 要求显式 AbortSignal；
 * Core broker 只传 request 会得到 "Cannot read properties of undefined (reading 'throwIfAborted')"。
 * 在宿主边界补一个 admission 超时信号，不改 lib/core/**。
 */
export function createBrokerSessionController(sessionController, { timeoutMs = 120_000 } = {}) {
  if (!sessionController) return null;
  return {
    prompt: (request) => sessionController.prompt(request, AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 120_000))),
  };
}

export function apply(ctx) {
  let sessionAdapter = null;
  let workspaceRegistry = null;
  let sessions = null;
  try {
    try {
      workspaceRegistry = ctx.get?.('workspaceRegistry') ?? ctx.workspaceRegistry ?? null;
    } catch {}
    try {
      sessions = ctx.get?.('sessions') ?? ctx.sessions ?? null;
    } catch {}
    sessionAdapter = createDshSessionAdapter({
      sessionController: ctx.sessionController,
      workspaceRegistry,
      sessions,
      logger: (...args) => console.log('[onefish-core]', ...args),
    });
  } catch (error) {
    console.log(`[onefish-core] 会话适配器不可用：${error?.message ?? error}`);
  }

  const memoryCompletion = createDshCompletion({
    sessionController: ctx.sessionController,
    workspaceRegistry,
    sessions,
    preset: 'onefish-core',
    cwd: REPO_ROOT,
    logger: (...args) => console.log('[onefish-core]', ...args),
  });

  let core;
  const memoryConsolidator = memoryCompletion
    ? async ({ day, digest, events }) => {
      const result = await core.memory.consolidate({ day, digest, events, complete: memoryCompletion.complete });
      core.log(`模型记忆提炼完成：${day} 应用 ${result.applied.length} / 跳过 ${result.skipped.length}`);
      return result;
    }
    : null;

  core = createCore({
    repoRoot: REPO_ROOT,
    logger: (...args) => console.log('[onefish-core]', ...args),
    sessionAdapter,
    memoryConsolidator,
    idlePrompt: ctx.sessionController
      ? async ({ sessionId, text }) => {
        const controller = createBrokerSessionController(ctx.sessionController);
        return controller.prompt({
          sessionId,
          requestId: randomUUID(),
          mode: 'queue',
          content: [{ type: 'text', text }],
        });
      }
      : null,
  });
  const disposers = [];

  let componentBroker = null;
  if (ctx.sessionController) {
    componentBroker = createDshComponentBroker({
      core,
      sessionController: createBrokerSessionController(ctx.sessionController),
      components: core.components,
      logger: (...args) => core.log(...args),
    });
    core.components.setSubmit((componentId, envelope) => componentBroker.submit(componentId, envelope));
    core.log('组件 broker 已启用（DSH prompt AbortSignal 适配）');
  }

  try {
    if (typeof ctx.provide === 'function') {
      const dispose = ctx.provide('onefishCore', core.componentApi);
      if (typeof dispose === 'function') disposers.push(dispose);
      core.log('onefishCore service 已注册');
    } else {
      core.log('onefishCore service 未注册：ctx.provide 不可用');
    }
  } catch (error) {
    core.log(`onefishCore service 注册失败：${error?.message ?? error}`);
  }

  function json(res, code, value) {
    try {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    } catch {}
  }

  function readConfigFile() {
    try {
      return JSON.parse(fs.readFileSync(core.paths.configFile, 'utf8')) || {};
    } catch {
      return {};
    }
  }

  function writeIdleConfig(idleClock) {
    const file = core.paths.configFile;
    const current = readConfigFile();
    const next = { ...current, idleClock };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
    return next;
  }

  // ── 配置：读 / 归一化写 / 差异回报 ───────────────────────────────
  /** 改完立即生效的字段；其余要重启插件（各服务启动时快照配置）。 */
  const CONFIG_LIVE_KEYS = ['idleClock'];

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function deepMerge(base, patch) {
    const out = { ...(isPlainObject(base) ? base : {}) };
    for (const [key, value] of Object.entries(patch || {})) {
      out[key] = isPlainObject(value) && isPlainObject(out[key]) ? { ...out[key], ...value } : value;
    }
    return out;
  }

  function flattenLeaves(value, prefix = '', out = {}) {
    if (isPlainObject(value)) {
      for (const [key, child] of Object.entries(value)) flattenLeaves(child, prefix ? `${prefix}.${key}` : key, out);
      return out;
    }
    out[prefix] = Array.isArray(value) ? JSON.stringify(value) : value;
    return out;
  }

  /** 把「请求里的值」和「归一化后的值」逐项对比，告诉设置页哪些被夹紧/丢弃了。 */
  function configWarnings(requested, normalized) {
    const want = flattenLeaves(requested);
    const got = flattenLeaves(normalized);
    const warnings = [];
    for (const [key, value] of Object.entries(want)) {
      if (value === undefined || value === null) continue;
      if (!(key in got)) {
        warnings.push({ path: key, requested: value, applied: undefined, reason: '未知配置项，已忽略' });
        continue;
      }
      if (String(got[key]) !== String(value)) {
        warnings.push({ path: key, requested: value, applied: got[key], reason: '已按取值范围修正' });
      }
    }
    return warnings;
  }

  function writeConfigFile(config) {
    const file = core.paths.configFile;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  }

  function configSnapshot() {
    return {
      ok: true,
      file: core.paths.configFile,
      config: core.config,
      defaults: DEFAULT_CONFIG,
      liveKeys: CONFIG_LIVE_KEYS,
    };
  }

  function applyConfigPatch(patch) {
    if (!isPlainObject(patch)) throw new Error('配置必须是 JSON 对象');
    const allowed = Object.keys(DEFAULT_CONFIG);
    const accepted = {};
    for (const [key, value] of Object.entries(patch)) {
      if (allowed.includes(key)) accepted[key] = value;
    }
    const requested = deepMerge(core.config, patch);
    const normalized = normalizeConfig(deepMerge(core.config, accepted));
    writeConfigFile(normalized);
    Object.assign(core.config, normalized);
    // 空闲钟有自己的 configure，能立即生效；其余服务是启动时快照，只能等重启。
    try { core.idle.configure(normalized.idleClock); } catch {}
    return {
      ok: true,
      config: core.config,
      applied: {
        live: CONFIG_LIVE_KEYS.filter((key) => key in accepted),
        restart: Object.keys(accepted).filter((key) => !CONFIG_LIVE_KEYS.includes(key)),
      },
      warnings: configWarnings(requested, normalized),
    };
  }

  // ── 首次使用：能自动补的都补上，补不了的说清楚 ───────────────────
  const STARTER_PERSONA = [
    '# 新角色',
    '',
    '## 你是谁',
    '- 名字：还没定，先把这里改成你自己想要的。',
    '- 一句话：这张卡是空壳，写满了才算有个人。',
    '',
    '## 你怎么说话',
    '- 短句、直接、不客套；不知道就说不知道。',
    '',
    '## 边界',
    '- 不装懂，不编造查不到的东西。',
    '',
  ].join('\n');

  async function bootstrap() {
    const actions = [];
    const push = (id, title, status, detail, hint = '') => actions.push({ id, title, status, detail, hint });

    let dirsOk = true;
    let dirsError = '';
    for (const dir of [core.paths.home, core.paths.charactersDir, core.paths.stateDir, core.paths.logsDir, core.paths.archiveDir, core.paths.componentsDir]) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch (error) { dirsOk = false; dirsError = String(error?.message ?? error); }
    }
    push('dirs', '数据目录', dirsOk ? 'done' : 'failed', dirsOk ? core.paths.home : dirsError,
      dirsOk ? '' : '确认这个路径可写，或用 ONEFISH_CORE_HOME 换一个');

    let personaStatus = 'skipped';
    let personaDetail = '已有人格卡，没有覆盖';
    try {
      const health = core.persona.health();
      const configured = health.hasCharacter || fs.existsSync(core.paths.fallbackPersona);
      if (!configured) {
        core.persona.update(STARTER_PERSONA);
        personaStatus = 'done';
        personaDetail = '写了一版空壳人格卡，去「人格」页改成你想要的';
      } else {
        personaDetail = `${health.name || '未命名'} · ${health.chars} 字`;
      }
    } catch (error) {
      personaStatus = 'failed';
      personaDetail = String(error?.message ?? error);
    }
    push('persona', '人格卡', personaStatus, personaDetail, personaStatus === 'done' ? '这条只是占位，写得越具体越不像客服' : '');

    let configStatus = 'skipped';
    let configDetail = '配置文件已存在，没有动它';
    try {
      if (!fs.existsSync(core.paths.configFile)) {
        writeConfigFile(normalizeConfig(core.config));
        configStatus = 'done';
        configDetail = core.paths.configFile;
      } else {
        configDetail = core.paths.configFile;
      }
    } catch (error) {
      configStatus = 'failed';
      configDetail = String(error?.message ?? error);
    }
    push('config', '配置文件', configStatus, configDetail);

    let embeddingStatus = 'skipped';
    let embeddingDetail = '向量模型未就绪，召回先用词面匹配';
    try {
      const status = core.embedding.status();
      if (status?.ready) {
        embeddingStatus = 'done';
        embeddingDetail = `已就绪（${status.backend || 'onnx'}）`;
      }
    } catch (error) {
      embeddingDetail = String(error?.message ?? error);
    }
    push('embedding', '向量模型', embeddingStatus, embeddingDetail,
      embeddingStatus === 'done' ? '' : '这一步需要本地模型文件，不能替你下载；装好后重启或重新自检');

    if (!sessionAdapter) {
      push('session', '今日会话', 'failed', '没有 sessionController，建不了日会话',
        '确认插件在 DSH 里正常加载，注入项齐全后重启');
    } else {
      try {
        const result = await core.session.ensureToday();
        push('session', '今日会话', 'done', result?.created === false ? '今天的日会话已经在了' : '已建立今日日会话');
      } catch (error) {
        push('session', '今日会话', 'failed', String(error?.message ?? error), '在 DSH 里随便发一条消息也会自动建');
      }
    }

    const done = actions.filter((item) => item.status === 'done').length;
    return { ok: actions.every((item) => item.status !== 'failed'), actions, done, total: actions.length };
  }

  // ── 自检：给「别人装一台」用，能自己看出哪儿不对 ────────────────
  function diagnostics() {
    const checks = [];
    const add = (id, title, status, detail, hint = '') => checks.push({ id, title, status, detail, hint });

    add('node', 'Node 运行时', Number(process.versions.node.split('.')[0]) >= 22 ? 'pass' : 'warn',
      `v${process.versions.node}`, '需要 Node ≥ 22.13');

    let homeWritable = false;
    let homeError = '';
    try {
      const probe = path.join(core.paths.stateDir, `.write-probe-${process.pid}`);
      fs.writeFileSync(probe, 'ok', 'utf8');
      fs.rmSync(probe, { force: true });
      homeWritable = true;
    } catch (error) {
      homeError = String(error?.message ?? error);
    }
    add('home', '数据目录可写', homeWritable ? 'pass' : 'fail', homeWritable ? core.paths.home : homeError,
      homeWritable ? '' : '检查目录权限，或用 ONEFISH_CORE_HOME 指到可写位置');

    const configExists = fs.existsSync(core.paths.configFile);
    add('config', '配置文件', configExists ? 'pass' : 'warn',
      configExists ? core.paths.configFile : '还没有 config.json（使用默认值）',
      configExists ? '' : '在「配置」页保存一次就会生成');

    const persona = core.persona.health();
    const personaConfigured = persona.hasCharacter || fs.existsSync(core.paths.fallbackPersona);
    add('persona', '人格卡', personaConfigured ? 'pass' : 'warn',
      personaConfigured ? `${persona.name || '未命名'} · ${persona.chars || 0} 字` : '还是内置的中性人格',
      personaConfigured ? '' : '点「一键初始化」写一版空壳，或去「人格」页写下它是什么人');

    const memory = core.memory.health();
    add('memory', '记忆', memory.total > 0 ? 'pass' : 'warn', `共 ${memory.total || 0} 条`,
      memory.total > 0 ? '' : '记几条事实，召回才有东西可挑');

    let embedding = { ready: false, backend: 'none' };
    try { embedding = core.embedding.status(); } catch (error) { embedding = { ready: false, backend: 'error', error: String(error?.message ?? error) }; }
    add('embedding', '向量检索', embedding?.ready ? 'pass' : 'warn',
      embedding?.ready ? `已就绪（${embedding.backend || 'onnx'}）` : '未就绪，召回退化为词面匹配',
      embedding?.ready ? '' : '装 onnxruntime + bge 模型，或在「配置」里指定 runtimeDir / modelDir');

    add('sessionAdapter', 'DSH 会话适配器', sessionAdapter ? 'pass' : 'fail',
      sessionAdapter ? '可用' : '不可用：没有拿到 sessionController',
      sessionAdapter ? '' : '确认插件在 DSH 里加载，且注入项 webServer / connection / sessionController 齐全');

    const stats = core.session.stats();
    add('session', '今日会话', stats.active ? 'pass' : 'warn',
      stats.active ? `${stats.currentDay} · ${stats.active.sessionId}` : '今天还没有日会话',
      stats.active ? '' : '在 DSH 里发一条消息，或点「新建今日会话」');

    add('archive', '档案', 'pass', `${core.archive.listDays().length} 天`, '');

    const components = core.components.list();
    add('components', '频道组件', components.length > 0 ? 'pass' : 'warn',
      components.length > 0 ? `${components.length} 个已登记` : '还没有登记任何组件',
      components.length > 0 ? '' : '装好组件后重启，它们会出现在「概览」里');

    const failed = checks.filter((item) => item.status === 'fail').length;
    const warned = checks.filter((item) => item.status === 'warn').length;
    return {
      ok: true,
      version: VERSION,
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      home: core.paths.home,
      configFile: core.paths.configFile,
      checks,
      summary: { pass: checks.length - failed - warned, warn: warned, fail: failed },
      embedding,
      components,
      memory,
      persona,
      session: stats,
    };
  }

  function isLoopback(req) {
    const host = String(req.headers?.host ?? '').trim().toLowerCase();
    if (!host) return false;
    const name = host.startsWith('[')
      ? (host.includes(']') ? host.slice(0, host.indexOf(']') + 1) : '')
      : host.split(':')[0];
    return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || host === '::1';
  }

  function sameOrigin(req) {
    const origin = req.headers?.origin;
    if (!origin) return true;
    try { return new URL(String(origin)).host.toLowerCase() === String(req.headers?.host ?? '').toLowerCase(); }
    catch { return false; }
  }

  function readBody(req, limit = 512 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve(text ? JSON.parse(text) : {}); } catch { reject(new Error('JSON 格式错误')); }
      });
      req.on('error', reject);
    });
  }

  function route(kind, pathname, handler) {
    if (!ctx.webServer?.register) return;
    disposers.push(ctx.webServer.register({
      kind,
      path: pathname,
      handler: async (req, res) => {
        if (!isLoopback(req)) { json(res, 403, { ok: false, error: '只接受本机回环访问' }); return; }
        if (req.method !== 'GET' && !sameOrigin(req)) { json(res, 403, { ok: false, error: '跨站请求被拒绝' }); return; }
        if (req.method !== 'GET' && !String(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')) {
          json(res, 415, { ok: false, error: '写操作必须是 application/json' });
          return;
        }
        try {
          const conn = ctx.get?.('connection');
          if (conn && typeof conn.requestRejection === 'function') {
            const code = conn.requestRejection(req);
            if (code !== undefined && code !== null && code !== false) {
              res.statusCode = typeof code === 'number' ? code : 403;
              res.end();
              return;
            }
          }
          await handler(req, res);
        } catch (error) {
          core.log(`API 失败：${error?.message ?? error}`);
          try { json(res, 500, { ok: false, error: String(error?.message ?? error) }); } catch {}
        }
      },
    }));
  }

  function overview() {
    const persona = core.persona.get();
    return {
      ok: true,
      name: 'OneFish Core',
      version: VERSION,
      home: core.paths.home,
      persona: {
        ...core.persona.health(),
        configured: core.persona.health().hasCharacter || fs.existsSync(core.paths.fallbackPersona),
        preview: String(persona.text || '').split('\n').slice(0, 3).join('\n'),
      },
      memory: core.memory.health(),
      session: core.session.stats(),
      currentSession: core.session.current(),
      recentSessions: core.session.list({ limit: 8 }),
      archive: { days: core.archive.listDays().length },
      components: core.components.list(),
      recentMemories: core.memory.list({ limit: 8 }),
    };
  }

  route('exact', '/dsh-onefish-core/health', async (req, res) => {
    json(res, 200, core.health());
  });

  route('prefix', API_PREFIX, async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;
    if (pathname === `${API_PREFIX}/overview` && req.method === 'GET') {
      json(res, 200, overview());
      return;
    }
    if (pathname === `${API_PREFIX}/config`) {
      if (req.method === 'GET') {
        json(res, 200, configSnapshot());
        return;
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        let patch = body;
        if (isPlainObject(body) && 'config' in body) patch = body.config;
        else if (isPlainObject(body) && 'patch' in body) patch = body.patch;
        let result;
        try {
          result = applyConfigPatch(patch || {});
        } catch (error) {
          json(res, 400, { ok: false, error: String(error?.message ?? error) });
          return;
        }
        core.log(`配置已更新：live=${result.applied.live.join(',') || '-'} restart=${result.applied.restart.join(',') || '-'}`);
        json(res, 200, result);
        return;
      }
    }
    if (pathname === `${API_PREFIX}/diagnostics` && req.method === 'GET') {
      json(res, 200, diagnostics());
      return;
    }
    if (pathname === `${API_PREFIX}/bootstrap` && req.method === 'POST') {
      json(res, 200, await bootstrap());
      return;
    }
    if (pathname === `${API_PREFIX}/persona`) {
      if (req.method === 'GET') {
        const persona = core.persona.get();
        json(res, 200, { ok: true, ...persona });
        return;
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const text = String(body?.text ?? '');
        if (!text.trim()) { json(res, 400, { ok: false, error: '人格卡不能为空' }); return; }
        const saved = core.persona.update(text);
        core.log('人格卡已保存');
        json(res, 200, { ok: true, ...saved });
        return;
      }
    }
    if (pathname === `${API_PREFIX}/memory` && req.method === 'GET') {
      const tier = String(url.searchParams.get('tier') ?? '');
      const q = String(url.searchParams.get('q') ?? '');
      const limit = Number(url.searchParams.get('limit') ?? 30);
      json(res, 200, { ok: true, entries: core.memory.list({ tier, q, limit }), stats: core.memory.stats() });
      return;
    }
    if (pathname === `${API_PREFIX}/memory` && req.method === 'POST') {
      const body = await readBody(req);
      if (!String(body?.text ?? '').trim()) { json(res, 400, { ok: false, error: '记忆内容不能为空' }); return; }
      const entry = core.memory.add({ ...body, by: 'owner' });
      json(res, 200, { ok: true, entry });
      return;
    }
    if (pathname === `${API_PREFIX}/memory/update` && req.method === 'POST') {
      const body = await readBody(req);
      const entry = body?.id ? core.memory.update(String(body.id), body) : null;
      if (!entry) { json(res, 404, { ok: false, error: '没有找到记忆' }); return; }
      json(res, 200, { ok: true, entry });
      return;
    }
    if (pathname === `${API_PREFIX}/memory/delete` && req.method === 'POST') {
      const body = await readBody(req);
      const entry = body?.id ? core.memory.remove(String(body.id)) : null;
      if (!entry) { json(res, 404, { ok: false, error: '没有找到记忆' }); return; }
      json(res, 200, { ok: true, entry });
      return;
    }
    if (pathname === `${API_PREFIX}/memory/maintain` && req.method === 'POST') {
      const body = await readBody(req);
      json(res, 200, await core.memory.maintain({ day: String(body?.day || '') }));
      return;
    }
    if (pathname === `${API_PREFIX}/session/bootpack` && req.method === 'GET') {
      const active = core.session.current();
      if (!active) { json(res, 404, { ok: false, error: '今天还没有日会话' }); return; }
      const text = core.bootPack.build({ day: active.day, workspace: active });
      json(res, 200, { ok: true, day: active.day, sessionId: active.sessionId, workspaceTitle: active.workspaceTitle, injectedAt: active.bootPackAt, chars: text.length, text });
      return;
    }
    if (pathname === `${API_PREFIX}/sessions` && req.method === 'GET') {
      const status = core.session.status();
      json(res, 200, { ok: true, ...status, current: status.active });
      return;
    }
    if (pathname === `${API_PREFIX}/idle/status` && req.method === 'GET') {
      json(res, 200, core.idle.status());
      return;
    }
    if (pathname === `${API_PREFIX}/idle/config` && req.method === 'GET') {
      json(res, 200, { ok: true, idleClock: core.idle.config });
      return;
    }
    if (pathname === `${API_PREFIX}/idle/config` && req.method === 'POST') {
      const body = await readBody(req);
      const patch = body?.idleClock && typeof body.idleClock === 'object' ? body.idleClock : body;
      const result = core.idle.configure(patch || {});
      writeIdleConfig(result.config);
      scheduleIdleTimer();
      core.log(`空闲钟配置已更新：enabled=${result.config.enabled}`);
      json(res, 200, { ok: true, ...result.status });
      return;
    }
    if (pathname === `${API_PREFIX}/idle/preview` && req.method === 'GET') {
      json(res, 200, core.idle.preview());
      return;
    }
    if (pathname === `${API_PREFIX}/idle/run` && req.method === 'POST') {
      json(res, 200, await core.idle.check({ manual: true }));
      return;
    }
    if (pathname === `${API_PREFIX}/session/ensure` && req.method === 'POST') {
      const result = await core.session.ensureToday();
      json(res, 200, { ok: true, ...result });
      return;
    }
    if (pathname === `${API_PREFIX}/session/consolidate` && req.method === 'POST') {
      const body = await readBody(req);
      const day = String(body?.day || '').trim();
      if (!day) { json(res, 400, { ok: false, error: 'day 不能为空' }); return; }
      const result = await core.session.consolidateDay(day, { force: body?.force === true });
      json(res, 200, { ok: true, ...result });
      return;
    }
    if (pathname === `${API_PREFIX}/session/retire` && req.method === 'POST') {
      const body = await readBody(req);
      const sessionId = String(body?.sessionId || '').trim();
      if (!sessionId) { json(res, 400, { ok: false, error: 'sessionId 不能为空' }); return; }
      const result = await core.session.retire(sessionId);
      json(res, 200, { ok: true, ...result });
      return;
    }
    json(res, 404, { ok: false, error: '未知接口' });
  });

  let off = null;
  try {
    if (typeof ctx.on === 'function') {
      off = ctx.on('session/event', (session, event) => {
        try {
          const sessionId = session?.id || event?.sessionId || event?.session_id || '';
          if (sessionId) core.session.noteActivity(sessionId, event || {});
          if (sessionId) {
            // DSH 当前正在 publish 这条事件；直接 append 会触发
            // "session append cannot reenter while another append is being published"。
            // 先让当前 publish 完成，再在微任务里注入开机包。
            queueMicrotask(() => {
              Promise.resolve(core.session.handleEvent(sessionId, event || {}))
                .catch((error) => core.log(`开机包事件处理失败：${error?.message ?? error}`));
            });
          }
          componentBroker?.handleEvent(session, event || {});
        } catch (error) {
          core.log(`会话事件处理失败：${error?.message ?? error}`);
        }
      });
    }
  } catch (error) {
    core.log(`会话事件监听注册失败：${error?.message ?? error}`);
  }

  let bootstrapTimer = null;
  let dayTimer = null;
  let idleTimer = null;

  function scheduleIdleTimer() {
    try { if (idleTimer) clearInterval(idleTimer); } catch {}
    idleTimer = null;
    if (!sessionAdapter) return;
    const interval = Math.max(30_000, Number(core.idle.config.checkIntervalMs) || 5 * 60 * 1000);
    idleTimer = setInterval(() => {
      core.idle.check().catch((error) => core.log(`空闲钟检查失败：${error?.message ?? error}`));
    }, interval);
    idleTimer.unref?.();
  }

  if (sessionAdapter) {
    bootstrapTimer = setTimeout(() => {
      core.session.bootstrap().catch((error) => core.log(`启动日会话失败：${error?.message ?? error}`));
    }, 1200);
    bootstrapTimer.unref?.();
    dayTimer = setInterval(() => {
      core.session.ensureToday().catch((error) => core.log(`日会话检查失败：${error?.message ?? error}`));
    }, 5 * 60 * 1000);
    dayTimer.unref?.();
    scheduleIdleTimer();
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      try { off?.(); } catch {}
      try { if (bootstrapTimer) clearTimeout(bootstrapTimer); } catch {}
      try { if (dayTimer) clearInterval(dayTimer); } catch {}
      try { if (idleTimer) clearInterval(idleTimer); } catch {}
      for (const dispose of disposers.splice(0)) { try { dispose?.(); } catch {} }
    });
  }

  core.log(`OneFish Core 已激活 v${VERSION}；home=${core.paths.home}；sessionAdapter=${Boolean(sessionAdapter)}`);
}

export default { name, inject, apply };
