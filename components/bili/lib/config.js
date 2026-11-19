/**
 * 组件配置：只用 ONEFISH_COMPONENT_STATE_DIR / ONEFISH_COMPONENT_CONFIG_FILE 这两条
 * opaque env（与 onefish-component-qq 同一约定），缺失时 fail closed，不猜 Core 路径。
 *
 * 凭据默认按下面的顺序找，第一个能读到的就用：
 *   1. config.credentialsFile（显式指定）
 *   2. <stateDir>/credentials.json（组件自管，迁移/扫码后可写这里）
 *   3. ~/.dsh/surfcore/bili/credentials.json（旧 surfcore 账号，兼容读取）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULTS = Object.freeze({
  credentialsFile: '',
  owner: { mid: '', name: '主人' },
  poll: {
    enabled: true,
    intervalSec: 120,
    dm: true,
    comment: true,
  },
  outbound: {
    maxDmLength: 300,
    maxCommentLength: 300,
    allowStrangerDm: true,
  },
  video: {
    ffmpegPath: '',
    workDir: '',
    maxFrames: 9,
    downloadDir: '',
  },
  dedupeWindow: 2000,
});

export function resolveStateDir(env = process.env) {
  const dir = String(env.ONEFISH_COMPONENT_STATE_DIR || '').trim();
  if (!dir) throw new Error('ONEFISH_COMPONENT_STATE_DIR 未设置（B站组件 fail closed，不推导 Core 路径）');
  return dir;
}

export function resolveConfigFile(stateDir, env = process.env) {
  const file = String(env.ONEFISH_COMPONENT_CONFIG_FILE || '').trim();
  if (file) return file;
  if (!stateDir) throw new Error('ONEFISH_COMPONENT_CONFIG_FILE 未设置');
  return componentConfigFile(stateDir);
}

/** 组件状态目录下的默认配置文件。 */
export function componentConfigFile(stateDir) {
  return path.join(String(stateDir || ''), 'config.json');
}

export function legacyCredentialsFile(home = os.homedir()) {
  return path.join(home, '.dsh', 'surfcore', 'bili', 'credentials.json');
}

function text(value, fallback = '') {
  const out = String(value ?? '').trim();
  return out || fallback;
}

function int(value, fallback, { min = 0, max = 100000 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 归一化配置：所有字段都有默认值，坏值回退。 */
export function normalizeConfig(input = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const poll = raw.poll && typeof raw.poll === 'object' ? raw.poll : {};
  const outbound = raw.outbound && typeof raw.outbound === 'object' ? raw.outbound : {};
  const video = raw.video && typeof raw.video === 'object' ? raw.video : {};
  const owner = raw.owner && typeof raw.owner === 'object' ? raw.owner : {};
  return Object.freeze({
    credentialsFile: text(raw.credentialsFile),
    owner: Object.freeze({
      mid: text(owner.mid),
      name: text(owner.name, DEFAULTS.owner.name),
    }),
    poll: Object.freeze({
      enabled: poll.enabled !== false,
      intervalSec: int(poll.intervalSec, DEFAULTS.poll.intervalSec, { min: 30, max: 3600 }),
      dm: poll.dm !== false,
      comment: poll.comment !== false,
    }),
    outbound: Object.freeze({
      maxDmLength: int(outbound.maxDmLength, DEFAULTS.outbound.maxDmLength, { min: 10, max: 2000 }),
      maxCommentLength: int(outbound.maxCommentLength, DEFAULTS.outbound.maxCommentLength, { min: 10, max: 2000 }),
      allowStrangerDm: outbound.allowStrangerDm !== false,
    }),
    video: Object.freeze({
      ffmpegPath: text(video.ffmpegPath),
      workDir: text(video.workDir),
      downloadDir: text(video.downloadDir),
      maxFrames: int(video.maxFrames, DEFAULTS.video.maxFrames, { min: 1, max: 16 }),
    }),
    dedupeWindow: int(raw.dedupeWindow, DEFAULTS.dedupeWindow, { min: 100, max: 20000 }),
  });
}

export function createDefaultConfig() {
  return normalizeConfig({});
}

export function readConfigFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return normalizeConfig(parsed);
  } catch {
    return null;
  }
}

export function writeConfigFile(file, config) {
  const normalized = normalizeConfig(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return normalized;
}

export function loadConfig({ stateDir, configFile } = {}) {
  const dir = stateDir || resolveStateDir();
  const file = configFile || resolveConfigFile(dir);
  return {
    stateDir: dir,
    configFile: file,
    config: readConfigFile(file) || createDefaultConfig(),
  };
}

/** 给 health / 日志用的摘要：不含凭据、不含完整路径细节以外的东西。 */
export function publicConfigSummary(config) {
  const normalized = normalizeConfig(config);
  return {
    poll: { ...normalized.poll },
    outbound: { ...normalized.outbound },
    video: { ffmpegPath: normalized.video.ffmpegPath ? '(set)' : '(auto)', maxFrames: normalized.video.maxFrames },
    owner: { mid: normalized.owner.mid ? '(set)' : '(none)', name: normalized.owner.name },
    credentialsFile: normalized.credentialsFile ? '(set)' : '(default)',
  };
}
