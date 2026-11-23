#!/usr/bin/env node
/**
 * 设置页后端接口回归：配置读写、自检、一键初始化。
 *
 * 不起 DSH：用一个假 ctx 顶住 webServer / effect，直接调路由处理器。
 * ONEFISH_CORE_HOME 指到临时目录，绝不碰真实数据。
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'onefish-core-api-'));
process.env.ONEFISH_CORE_HOME = temp;
process.env.DSH_HOME = path.join(temp, 'dsh');

const API = '/dsh-onefish-core/api';
let failed = 0;

async function test(title, fn) {
  try {
    await fn();
    console.log(`✔ ${title}`);
  } catch (error) {
    failed += 1;
    console.error(`✘ ${title}\n  ${error?.message || error}`);
  }
}

function createCtx() {
  const routes = new Map();
  const cleanups = [];
  return {
    routes,
    cleanups,
    webServer: {
      register({ kind, path: routePath, handler }) {
        routes.set(`${kind}:${routePath}`, handler);
        return () => {};
      },
    },
    get() { return undefined; },
    provide() { return () => {}; },
    on() { return () => {}; },
    effect(fn) {
      try {
        const dispose = fn();
        if (typeof dispose === 'function') cleanups.push(dispose);
      } catch {}
    },
  };
}

function fakeReq({ method = 'GET', url = API, body, headers = {} } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:12345', 'content-type': 'application/json', ...headers };
  req.destroy = () => {};
  setImmediate(() => {
    if (body !== undefined) req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    chunks: [],
    writeHead(code, headers) {
      res.statusCode = code;
      Object.assign(res.headers, headers || {});
    },
    end(chunk) {
      if (chunk) res.chunks.push(Buffer.from(chunk));
      res.finished = true;
    },
    get body() { return Buffer.concat(res.chunks).toString('utf8'); },
    get json() { try { return JSON.parse(res.body); } catch { return null; } },
  };
  return res;
}

async function call(handler, options = {}) {
  const res = fakeRes();
  await handler(fakeReq(options), res);
  return res;
}

try {
  const moduleUrl = pathToFileURL(path.join(import.meta.dirname, '..', 'lib', 'index.js')).href;
  const plugin = await import(moduleUrl);
  const ctx = createCtx();
  plugin.apply(ctx);
  const api = ctx.routes.get(`prefix:${API}`);
  const configFile = path.join(temp, 'config.json');
  const personaFile = path.join(temp, 'persona.md');

  await test('GET /config：返回当前配置、默认值和可即时生效的键', async () => {
    assert.ok(api, '应注册 API 前缀路由');
    const res = await call(api, { url: `${API}/config` });
    assert.equal(res.statusCode, 200);
    const data = res.json;
    assert.equal(data.ok, true);
    assert.equal(typeof data.config.recall.topK, 'number');
    assert.ok(data.liveKeys.includes('idleClock'));
    assert.equal(data.file, configFile);
  });

  await test('POST /config：超范围的值被夹紧，并逐项回报', async () => {
    const res = await call(api, {
      method: 'POST',
      url: `${API}/config`,
      body: { config: { recall: { topK: 99 }, bootMaxChars: 999999 } },
    });
    assert.equal(res.statusCode, 200);
    const data = res.json;
    assert.equal(data.config.recall.topK, 6, 'topK 上限 6');
    assert.equal(data.config.bootMaxChars, 12000);
    const paths = data.warnings.map((item) => item.path);
    assert.ok(paths.includes('recall.topK'), '应回报 recall.topK 被修正');
    assert.ok(paths.includes('bootMaxChars'), '应回报 bootMaxChars 被修正');
    assert.ok(data.applied.restart.includes('recall'), '召回要重启生效');
  });

  await test('POST /config：未知配置项被忽略并写进 warnings，不落进文件', async () => {
    const res = await call(api, { method: 'POST', url: `${API}/config`, body: { config: { foo: 'bar' } } });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json.warnings.some((item) => item.path === 'foo'));
    const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.equal('foo' in saved, false, '未知键不该写进 config.json');
  });

  await test('POST /config：非对象直接 400，不写文件', async () => {
    const before = fs.readFileSync(configFile, 'utf8');
    const res = await call(api, { method: 'POST', url: `${API}/config`, body: { config: 'nope' } });
    assert.equal(res.statusCode, 400);
    assert.equal(fs.readFileSync(configFile, 'utf8'), before);
  });

  await test('GET /diagnostics：关键检查项齐全，缺 sessionController 能报出来', async () => {
    const res = await call(api, { url: `${API}/diagnostics` });
    assert.equal(res.statusCode, 200);
    const data = res.json;
    const ids = data.checks.map((item) => item.id);
    for (const id of ['node', 'home', 'config', 'persona', 'memory', 'embedding', 'sessionAdapter', 'session']) {
      assert.ok(ids.includes(id), `缺少检查项：${id}`);
    }
    const sessionCheck = data.checks.find((item) => item.id === 'sessionAdapter');
    assert.equal(sessionCheck.status, 'fail', '没有 sessionController 时应判失败');
    assert.match(sessionCheck.detail, /sessionController/);
    assert.equal(data.home, temp);
  });

  await test('POST /bootstrap：空目录能补出人格卡和配置，且可重复执行', async () => {
    fs.rmSync(personaFile, { force: true });
    const first = await call(api, { method: 'POST', url: `${API}/bootstrap` });
    assert.equal(first.statusCode, 200);
    const actions = first.json.actions;
    assert.equal(actions.find((item) => item.id === 'dirs').status, 'done');
    assert.equal(actions.find((item) => item.id === 'persona').status, 'done');
    assert.ok(fs.existsSync(configFile), '应写出配置文件');
    assert.match(fs.readFileSync(personaFile, 'utf8'), /新角色/);

    const second = await call(api, { method: 'POST', url: `${API}/bootstrap` });
    assert.equal(second.json.actions.find((item) => item.id === 'persona').status, 'skipped', '不该覆盖已有人格');
  });

  await test('POST /bootstrap：没 sessionController 时如实报失败并给提示', async () => {
    const res = await call(api, { method: 'POST', url: `${API}/bootstrap` });
    const session = res.json.actions.find((item) => item.id === 'session');
    assert.equal(session.status, 'failed');
    assert.ok(session.hint, '失败项要给下一步提示');
  });

  await test('非回环 Host 直接 403', async () => {
    const res = await call(api, { url: `${API}/config`, headers: { host: 'evil.example.com' } });
    assert.equal(res.statusCode, 403);
  });

  await test('跨站写操作被拒绝', async () => {
    const res = await call(api, {
      method: 'POST',
      url: `${API}/config`,
      body: { config: { bootMaxChars: 5000 } },
      headers: { origin: 'https://evil.example.com' },
    });
    assert.equal(res.statusCode, 403);
  });
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log('✅ 设置页 API 测试通过');

