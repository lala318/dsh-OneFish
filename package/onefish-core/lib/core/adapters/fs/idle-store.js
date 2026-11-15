/**
 * 空闲钟状态：core/idle-clock.json。
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_STATE = Object.freeze({
  version: 1,
  day: '',
  countToday: 0,
  lastConsiderAt: 0,
  nextEligibleAt: 0,
  lastIdleMs: 0,
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

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function createIdleStore({ paths }) {
  function read() {
    const raw = readJson(paths.idleStateFile);
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_STATE };
    return {
      ...DEFAULT_STATE,
      ...raw,
      countToday: Math.max(0, Number(raw.countToday) || 0),
      lastConsiderAt: Number(raw.lastConsiderAt) || 0,
      nextEligibleAt: Number(raw.nextEligibleAt) || 0,
      lastIdleMs: Math.max(0, Number(raw.lastIdleMs) || 0),
    };
  }

  function write(patch = {}) {
    const next = { ...read(), ...patch, version: 1, updatedAt: Date.now() };
    writeJsonAtomic(paths.idleStateFile, next);
    return next;
  }

  return { read, write, file: paths.idleStateFile };
}
