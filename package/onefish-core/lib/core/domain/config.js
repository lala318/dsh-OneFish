/**
 * Core 配置规则：默认值 + 纯归一化，不读文件。
 *
 * 文件读取在 adapters/fs/config.js；这样 application 不依赖 fs。
 */
import { DEFAULT_ROLLOVER_HOUR } from './day.js';

export const DEFAULT_CONFIG = Object.freeze({
  rolloverHour: DEFAULT_ROLLOVER_HOUR,
  preset: 'onefish-core',
  titlePrefix: 'OneFish',
  workspaceTitle: 'onefish',
  workspacePath: '',
  autoConsolidate: true,
  consolidateOnBootstrap: true,
  bootMaxChars: 5000,
  personaMaxChars: 2000,
  digestMaxChars: 1200,
  historyPageMessages: 200,
  historyMaxPages: 50,
  timestamp: { enabled: true },
  embedding: { runtimeDir: '', modelDir: '' },
  idleClock: {
    enabled: false,
    checkIntervalMs: 5 * 60 * 1000,
    minIdleMs: 10 * 60 * 1000,
    scaleHours: 3,
    shape: 2,
    cooldownMinMs: 45 * 60 * 1000,
    cooldownMaxMs: 90 * 60 * 1000,
  },
  components: {},
});

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** 把任意 JSON 对象归一化成合法 Core 配置；纯函数。 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    ...DEFAULT_CONFIG,
    ...source,
    rolloverHour: clampInt(source.rolloverHour, DEFAULT_CONFIG.rolloverHour, 0, 23),
    historyPageMessages: clampInt(source.historyPageMessages, DEFAULT_CONFIG.historyPageMessages, 1, 1000),
    historyMaxPages: clampInt(source.historyMaxPages, DEFAULT_CONFIG.historyMaxPages, 1, 200),
    preset: typeof source.preset === 'string' && source.preset.trim() ? source.preset.trim() : DEFAULT_CONFIG.preset,
    titlePrefix: typeof source.titlePrefix === 'string' && source.titlePrefix.trim() ? source.titlePrefix.trim() : DEFAULT_CONFIG.titlePrefix,
    workspaceTitle: typeof source.workspaceTitle === 'string' && source.workspaceTitle.trim() ? source.workspaceTitle.trim() : DEFAULT_CONFIG.workspaceTitle,
    workspacePath: typeof source.workspacePath === 'string' && source.workspacePath.trim() ? source.workspacePath.trim() : DEFAULT_CONFIG.workspacePath,
    bootMaxChars: clampInt(source.bootMaxChars, DEFAULT_CONFIG.bootMaxChars, 1000, 12000),
    personaMaxChars: clampInt(source.personaMaxChars, DEFAULT_CONFIG.personaMaxChars, 200, 6000),
    digestMaxChars: clampInt(source.digestMaxChars, DEFAULT_CONFIG.digestMaxChars, 200, 4000),
    autoConsolidate: source.autoConsolidate !== false,
    consolidateOnBootstrap: source.consolidateOnBootstrap !== false,
    timestamp: {
      ...DEFAULT_CONFIG.timestamp,
      ...(source.timestamp && typeof source.timestamp === 'object' ? source.timestamp : {}),
      enabled: !(source.timestamp && source.timestamp.enabled === false),
    },
    embedding: {
      runtimeDir: typeof source.embedding?.runtimeDir === 'string' ? source.embedding.runtimeDir.trim() : '',
      modelDir: typeof source.embedding?.modelDir === 'string' ? source.embedding.modelDir.trim() : '',
    },
    idleClock: {
      ...DEFAULT_CONFIG.idleClock,
      ...(source.idleClock && typeof source.idleClock === 'object' ? source.idleClock : {}),
      enabled: source.idleClock?.enabled === true,
    },
  };
}
