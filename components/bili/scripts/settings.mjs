#!/usr/bin/env node
/**
 * B站组件自管配置入口。
 *
 *   npm run settings -- show
 *   npm run settings -- path
 *   npm run settings -- set-json '{"owner":{"mid":"123"}}'
 *
 * 配置文件由 ONEFISH_COMPONENT_CONFIG_FILE 指定；未指定时使用
 * ONEFISH_COMPONENT_STATE_DIR/config.json。两项都缺失时直接失败，不推导 Core 路径。
 */
import fs from 'node:fs';
import {
  normalizeConfig,
  readConfigFile,
  writeConfigFile,
  publicConfigSummary,
} from '../lib/config.js';

const stateDir = String(process.env.ONEFISH_COMPONENT_STATE_DIR || '').trim();
const configFile = String(process.env.ONEFISH_COMPONENT_CONFIG_FILE || '').trim()
  || (stateDir ? `${stateDir.replace(/[\\/]$/, '')}${process.platform === 'win32' ? '\\' : '/'}config.json` : '');

if (!configFile) {
  console.error('缺少 ONEFISH_COMPONENT_CONFIG_FILE 或 ONEFISH_COMPONENT_STATE_DIR；B站设置入口 fail closed。');
  process.exit(1);
}

function load() {
  return readConfigFile(configFile) || normalizeConfig({});
}

function merge(current, patch) {
  const source = patch && typeof patch === 'object' ? patch : {};
  return normalizeConfig({
    ...current,
    ...source,
    owner: { ...(current.owner || {}), ...(source.owner || {}) },
    poll: { ...(current.poll || {}), ...(source.poll || {}) },
    outbound: { ...(current.outbound || {}), ...(source.outbound || {}) },
    video: { ...(current.video || {}), ...(source.video || {}) },
  });
}

const [command = 'show', ...args] = process.argv.slice(2);

try {
  if (command === 'path') {
    console.log(configFile);
  } else if (command === 'show') {
    console.log(JSON.stringify({
      configFile,
      exists: fs.existsSync(configFile),
      config: publicConfigSummary(load()),
    }, null, 2));
  } else if (command === 'set-json') {
    const raw = args.join(' ').trim();
    if (!raw) throw new Error('set-json 需要 JSON 对象');
    let patch;
    try {
      patch = JSON.parse(raw);
    } catch (error) {
      throw new Error(`JSON 解析失败：${error?.message ?? error}`);
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('set-json 必须是对象');
    const next = merge(load(), patch);
    writeConfigFile(configFile, next);
    console.log(JSON.stringify({ ok: true, configFile, config: publicConfigSummary(next) }, null, 2));
  } else {
    throw new Error(`未知命令：${command}。可用：show / path / set-json`);
  }
} catch (error) {
  console.error(error?.message ?? error);
  process.exit(1);
}
