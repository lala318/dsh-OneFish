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
  // 每轮自动召回：不等待向量模型，用本地词面匹配（中文按二元组），避免把回复拖慢。
  recall: {
    enabled: true,
    topK: 3,
    minScore: 0.6,
    minRelevance: 0.4,
    lexicalMinScore: 0.35,
    timeoutMs: 600,
    maxChars: 600,
    minQueryChars: 6,
    maxQueryChars: 800,
    skipPrefixes: ['【空闲】', '【开机包】', '【记忆召回】'],
    skipFirstTurn: true,
  },
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
    recall: {
      ...DEFAULT_CONFIG.recall,
      ...(source.recall && typeof source.recall === 'object' ? source.recall : {}),
      enabled: !(source.recall && source.recall.enabled === false),
      topK: clampInt(source.recall?.topK, DEFAULT_CONFIG.recall.topK, 1, 6),
      minScore: (() => {
        const n = Number(source.recall?.minScore);
        return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : DEFAULT_CONFIG.recall.minScore;
      })(),
      lexicalMinScore: (() => {
        const n = Number(source.recall?.lexicalMinScore);
        return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : DEFAULT_CONFIG.recall.lexicalMinScore;
      })(),
      minRelevance: (() => {
        const n = Number(source.recall?.minRelevance);
        return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : DEFAULT_CONFIG.recall.minRelevance;
      })(),
      timeoutMs: clampInt(source.recall?.timeoutMs, DEFAULT_CONFIG.recall.timeoutMs, 100, 5000),
      maxChars: clampInt(source.recall?.maxChars, DEFAULT_CONFIG.recall.maxChars, 200, 2000),
      minQueryChars: clampInt(source.recall?.minQueryChars, DEFAULT_CONFIG.recall.minQueryChars, 2, 200),
      maxQueryChars: clampInt(source.recall?.maxQueryChars, DEFAULT_CONFIG.recall.maxQueryChars, 100, 4000),
      skipPrefixes: Array.isArray(source.recall?.skipPrefixes)
        ? source.recall.skipPrefixes.map((item) => String(item)).filter(Boolean).slice(0, 10)
        : DEFAULT_CONFIG.recall.skipPrefixes,
      skipFirstTurn: source.recall?.skipFirstTurn !== false,
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
