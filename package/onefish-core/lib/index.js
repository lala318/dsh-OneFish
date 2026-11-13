/**
 * OneFish Core —— DSH 宿主半边（MVP）。
 *
 * 只做三件事：
 *   1. 启动核心服务（人格 / 记忆 / 日会话生命周期）；
 *   2. 暴露最小设置页 API；
 *   3. 订阅 DSH 会话事件，更新日会话活跃时间。
 *
 * 不加载 QQ / B站 / 桌宠；那些以后作为可选组件接入。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCore } from './core/index.js';
import { createDshSessionAdapter } from './dsh/session-adapter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const API_PREFIX = '/dsh-onefish-core/api';
const VERSION = '0.1.0';

export const name = 'onefish-core';
export const inject = ['webServer', 'connection', 'sessionController'];

export function apply(ctx) {
  let sessionAdapter = null;
  try {
    let workspaceRegistry = null;
    try {
      workspaceRegistry = ctx.get?.('workspaceRegistry') ?? ctx.workspaceRegistry ?? null;
    } catch {}
    let sessions = null;
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

  const core = createCore({
    repoRoot: REPO_ROOT,
    logger: (...args) => console.log('[onefish-core]', ...args),
    sessionAdapter,
  });
  const disposers = [];

  function json(res, code, value) {
    try {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    } catch {}
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
        preview: String(persona.text || '').split('\n').slice(0, 3).join('\n'),
      },
      memory: core.memory.health(),
      session: core.session.stats(),
      currentSession: core.session.current(),
      recentSessions: core.session.list({ limit: 8 }),
      archive: { days: core.archive.listDays().length },
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
  if (sessionAdapter) {
    bootstrapTimer = setTimeout(() => {
      core.session.bootstrap().catch((error) => core.log(`启动日会话失败：${error?.message ?? error}`));
    }, 1200);
    bootstrapTimer.unref?.();
    dayTimer = setInterval(() => {
      core.session.ensureToday().catch((error) => core.log(`日会话检查失败：${error?.message ?? error}`));
    }, 5 * 60 * 1000);
    dayTimer.unref?.();
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      try { off?.(); } catch {}
      try { if (bootstrapTimer) clearTimeout(bootstrapTimer); } catch {}
      try { if (dayTimer) clearInterval(dayTimer); } catch {}
      for (const dispose of disposers.splice(0)) { try { dispose?.(); } catch {} }
    });
  }

  core.log(`OneFish Core 已激活 v${VERSION}；home=${core.paths.home}；sessionAdapter=${Boolean(sessionAdapter)}`);
}

export default { name, inject, apply };
