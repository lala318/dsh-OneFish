/**
 * 组件本地状态：水位 / 去重窗口 / 最近一次唤醒。
 *
 * 入站轮询是「拉」的：每次轮询记录每个会话/收件箱的水位，只把水位之后的当新消息。
 * 状态损坏时备份后降级为空状态，不覆盖证据。
 */
import fs from 'node:fs';
import path from 'node:path';

function now() {
  return Date.now();
}

export function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function createStateStore({ dir, limit = 2000, logger = () => {} } = {}) {
  const file = path.join(dir, 'state.json');
  let state = readJsonFile(file, null);
  if (!state || typeof state !== 'object') {
    if (fs.existsSync(file)) {
      try {
        fs.renameSync(file, path.join(dir, `state.corrupt-${Date.now()}.json`));
      } catch {}
    }
    state = { seen: {}, watermarks: {}, updatedAt: 0 };
  }
  if (!state.seen || typeof state.seen !== 'object') state.seen = {};
  if (!state.watermarks || typeof state.watermarks !== 'object') state.watermarks = {};
  if (!state.flags || typeof state.flags !== 'object') state.flags = {};
  const seenOrder = Array.isArray(state.seenOrder) ? state.seenOrder : [];
  let timer = null;
  let dirty = false;

  function flush() {
    timer = null;
    if (!dirty) return;
    dirty = false;
    state.updatedAt = now();
    try {
      writeJsonAtomic(file, state);
    } catch (error) {
      logger(`写状态失败：${error?.message ?? error}`);
    }
  }

  function schedule() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(flush, 800);
  }

  return {
    isDuplicate(key) {
      return Boolean(state.seen[String(key)]);
    },
    remember(key) {
      const k = String(key);
      if (state.seen[k]) return;
      state.seen[k] = now();
      seenOrder.push(k);
      while (seenOrder.length > limit) {
        const drop = seenOrder.shift();
        delete state.seen[drop];
      }
      state.seenOrder = seenOrder;
      schedule();
    },
    getWatermark(key) {
      return Number(state.watermarks[String(key)] ?? 0) || 0;
    },
    setWatermark(key, value) {
      const k = String(key);
      const v = Number(value) || 0;
      if (v <= (Number(state.watermarks[k]) || 0)) return false;
      state.watermarks[k] = v;
      schedule();
      return true;
    },
    getFlag(name) {
      return state.flags[String(name)] === true;
    },
    setFlag(name, value = true) {
      state.flags[String(name)] = Boolean(value);
      schedule();
    },
    stats() {
      return { seen: Object.keys(state.seen).length, watermarks: Object.keys(state.watermarks).length, flags: { ...state.flags }, updatedAt: state.updatedAt };
    },
    flush() {
      dirty = true;
      flush();
    },
    close() {
      if (timer) clearTimeout(timer);
      timer = null;
      flush();
    },
  };
}
