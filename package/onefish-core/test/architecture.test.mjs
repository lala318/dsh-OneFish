#!/usr/bin/env node
/**
 * 分层边界回归：
 * - domain 不读文件、不依赖 DSH/MCP；
 * - adapters 子目录存在；
 * - host 只通过 core/index 与 adapters/dsh 接触。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const packageRoot = root;
const core = path.join(root, 'lib', 'core');
const domain = path.join(core, 'domain');
const application = path.join(core, 'application');
const adaptersFs = path.join(core, 'adapters', 'fs');
const adaptersDsh = path.join(core, 'adapters', 'dsh');

for (const dir of [domain, application, adaptersFs, adaptersDsh]) {
  assert.ok(fs.existsSync(dir), `缺少目录：${dir}`);
}

const domainFiles = fs.readdirSync(domain).filter((name) => name.endsWith('.js'));
assert.ok(domainFiles.length >= 3);
for (const name of domainFiles) {
  const source = fs.readFileSync(path.join(domain, name), 'utf8');
  assert.doesNotMatch(source, /from ['"]node:fs['"]/, `${name} 不应 import node:fs`);
  assert.doesNotMatch(source, /from ['"]node:path['"]/, `${name} 不应 import node:path`);
  assert.doesNotMatch(source, /@deepseek-ai|mcp__|\.\.\/adapters/, `${name} 不应依赖 DSH/MCP/adapters`);
}

const hostFiles = ['index.js', 'client.js'];
for (const name of hostFiles) {
  const source = fs.readFileSync(path.join(packageRoot, 'lib', name), 'utf8');
  assert.doesNotMatch(source, /\bqq\b|QQ|component-config|components\/qq/i, `${name} 不应出现具体组件特化`);
}

const presetSource = fs.readFileSync(path.join(packageRoot, 'presets', 'onefish-core.patch.yml'), 'utf8');
assert.doesNotMatch(presetSource, /\bQQ\b|\bqq_send_message\b|\bonefish-qq\b/, 'preset 不应写死 QQ 组件');

const applicationFiles = fs.readdirSync(application).filter((name) => name.endsWith('.js'));
assert.ok(applicationFiles.length >= 4);
for (const name of applicationFiles) {
  const source = fs.readFileSync(path.join(application, name), 'utf8');
  assert.doesNotMatch(source, /from ['"]node:fs['"]/, `${name} 不应 import node:fs`);
  assert.doesNotMatch(source, /from ['"]node:path['"]/, `${name} 不应 import node:path`);
  assert.doesNotMatch(source, /from ['"]\.\.\/adapters\//, `${name} 不应直接 import adapters`);
  assert.doesNotMatch(source, /@deepseek-ai/, `${name} 不应依赖 DSH`);
}

const host = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8');
assert.match(host, /from '\.\/core\/adapters\/dsh\/session-adapter\.js'/);
assert.match(host, /from '\.\/core\/index\.js'/);

const adapterTest = fs.readFileSync(path.join(root, 'test', 'session-adapter.test.mjs'), 'utf8');
assert.match(adapterTest, /lib\/core\/adapters\/dsh\/session-adapter\.js/);

console.log('✅ 分层边界测试通过');
