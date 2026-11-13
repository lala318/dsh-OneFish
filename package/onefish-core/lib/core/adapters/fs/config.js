/**
 * 配置文件读取：只负责读 JSON，然后交给 domain/config 归一化。
 */
import fs from 'node:fs';
import { normalizeConfig } from '../../domain/config.js';

function readJson(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function loadConfig(file) {
  return normalizeConfig(readJson(file) || {});
}
