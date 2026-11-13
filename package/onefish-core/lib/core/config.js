/**
 * Core 配置：只读 JSON，缺省值集中在 DEFAULT_CONFIG。
 *
 * 这里不写配置；设置页以后可以写这个文件，或由宿主自己的 settings 提供。
 */
import fs from 'node:fs';
import { DEFAULT_ROLLOVER_HOUR } from './day.js';

export const DEFAULT_CONFIG = Object.freeze({
  rolloverHour: DEFAULT_ROLLOVER_HOUR,
  preset: 'onefish-core',
  titlePrefix: 'OneFish',
  autoConsolidate: true,
  consolidateOnBootstrap: true,
  historyPageMessages: 200,
  historyMaxPages: 50,
});

function readJson(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function loadConfig(file) {
  const raw = readJson(file) || {};
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    rolloverHour: clampInt(raw.rolloverHour, DEFAULT_CONFIG.rolloverHour, 0, 23),
    historyPageMessages: clampInt(raw.historyPageMessages, DEFAULT_CONFIG.historyPageMessages, 1, 1000),
    historyMaxPages: clampInt(raw.historyMaxPages, DEFAULT_CONFIG.historyMaxPages, 1, 200),
    preset: typeof raw.preset === 'string' && raw.preset.trim() ? raw.preset.trim() : DEFAULT_CONFIG.preset,
    titlePrefix: typeof raw.titlePrefix === 'string' && raw.titlePrefix.trim() ? raw.titlePrefix.trim() : DEFAULT_CONFIG.titlePrefix,
    autoConsolidate: raw.autoConsolidate !== false,
    consolidateOnBootstrap: raw.consolidateOnBootstrap !== false,
  };
}
