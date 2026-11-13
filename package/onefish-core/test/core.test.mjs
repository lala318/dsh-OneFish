#!/usr/bin/env node
/**
 * OneFish Core 最小回归：人格 / 记忆 / 日会话 / 插件注册 / preset 结构。
 * 运行：node onefish-core/test/core.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { createCore } from '../lib/core/index.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'onefish-core-test-'));

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

try {
  const characterDir = path.join(temp, 'characters', 'c1');
  write(path.join(temp, 'characters', 'current.json'), JSON.stringify({ version: 1, id: 'c1', name: '测试角色', epoch: 1 }));
  write(path.join(characterDir, 'character.json'), JSON.stringify({ name: '测试角色', personaMeta: { name: '测试角色' } }));
  write(path.join(characterDir, 'persona.md'), '# 测试角色\n\n你是一个简洁的测试人格。\n');

  const core = createCore({ home: temp, repoRoot: root });

  // 默认数据根必须与旧 SurfCore 隔离。
  const childHome = path.join(temp, 'dsh-home');
  const pathsModule = pathToFileURL(path.join(root, 'onefish-core/lib/core/paths.js')).href;
  const defaultHome = execFileSync(process.execPath, [
    '--input-type=module',
    '-e',
    `import { resolveCoreHome } from ${JSON.stringify(pathsModule)}; console.log(resolveCoreHome());`,
  ], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: childHome, ONEFISH_CORE_HOME: '' },
  }).trim();
  assert.equal(defaultHome, path.join(childHome, 'onefish-core'));
  assert.ok(!defaultHome.toLowerCase().includes('surfcore'), '默认数据根不能落到旧 SurfCore 目录');

  // 人格
  const persona = core.persona.get();
  assert.equal(persona.name, '测试角色');
  assert.match(persona.text, /简洁的测试人格/);
  assert.match(core.persona.block(), /当前人格卡/);
  core.persona.update('# 新人格\n\n更简洁。\n');
  assert.match(core.persona.get().text, /更简洁/);

  // 记忆
  const added = core.memory.add({ text: '主人正在重构 OneFish 核心', tier: 'active', kind: 'fact', tags: ['项目'] });
  assert.ok(added.id);
  const found = core.memory.search('重构', { k: 5 });
  assert.ok(found.some((item) => item.id === added.id), 'search 应能命中新记忆');
  const list = core.memory.list({ limit: 10 });
  assert.ok(list.some((item) => item.id === added.id));
  const updated = core.memory.update(added.id, { text: '主人正在重构 OneFish 核心（MVP）' });
  assert.match(updated.text, /MVP/);
  const removed = core.memory.remove(added.id);
  assert.ok(removed.deletedAt);
  assert.equal(core.memory.list({ includeDeleted: true }).filter((item) => item.id === added.id).length, 1);
  assert.ok(core.memory.stats().deleted >= 1);

  // 会话索引：DSH 消息历史不归 core，默认没有 active 日会话。
  assert.equal(core.session.stats().active, false);
  assert.equal(core.session.stats().recent, 0);

  // 插件 apply（假 ctx，只验证注册不抛）
  process.env.ONEFISH_CORE_HOME = temp;
  const routes = [];
  const fakeCtx = {
    webServer: { register: (route) => { routes.push(route); return () => {}; } },
    connection: {},
    get: () => null,
    on: () => () => {},
    effect: (fn) => { fn(); return () => {}; },
  };
  const plugin = await import('../lib/index.js');
  assert.equal(plugin.name, 'onefish-core');
  plugin.apply(fakeCtx);
  assert.ok(routes.length >= 2, '应注册 health + api 路由');
  assert.ok(routes.some((route) => route.path === '/dsh-onefish-core/health'));
  assert.ok(routes.some((route) => route.path === '/dsh-onefish-core/api'));

  // preset / bundle patch YAML 结构
  const preset = yaml.load(fs.readFileSync(path.join(root, 'onefish-core/presets/onefish-core.patch.yml'), 'utf8'));
  const presetRow = preset?.[0]?.insert?.[0];
  assert.equal(presetRow?.config?.id, 'onefish-core');
  assert.ok(Array.isArray(presetRow?.config?.plugins));
  assert.ok(presetRow.config.plugins.some((row) => row.id === 'persona'));
  const bundle = yaml.load(fs.readFileSync(path.join(root, 'onefish-core/cordis.patch.yml'), 'utf8'));
  assert.equal(bundle?.[0]?.insert?.[0]?.id, 'onefish-core');

  console.log('✅ OneFish Core 测试通过');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
