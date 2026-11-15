/**
 * 空闲钟：会话安静越久，越可能触发一次「自己想点事情」。
 *
 * 纯函数，不碰文件/DSH；调度与 prompt 在 application/host。
 */
export const DEFAULT_IDLE_CLOCK = Object.freeze({
  enabled: false,
  checkIntervalMs: 5 * 60 * 1000,
  minIdleMs: 10 * 60 * 1000,
  scaleHours: 3,
  shape: 2,
  cooldownMinMs: 45 * 60 * 1000,
  cooldownMaxMs: 90 * 60 * 1000,
});

const clampNumber = (value, fallback, min, max) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const clampInt = (value, fallback, min, max) => Math.round(clampNumber(value, fallback, min, max));

export function normalizeIdleClock(raw = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const checkIntervalMs = clampInt(src.checkIntervalMs, DEFAULT_IDLE_CLOCK.checkIntervalMs, 30_000, 60 * 60 * 1000);
  const minIdleMs = clampInt(src.minIdleMs, DEFAULT_IDLE_CLOCK.minIdleMs, 0, 24 * 60 * 60 * 1000);
  const cooldownMinMs = clampInt(src.cooldownMinMs, DEFAULT_IDLE_CLOCK.cooldownMinMs, 0, 24 * 60 * 60 * 1000);
  const cooldownMaxMs = clampInt(src.cooldownMaxMs, DEFAULT_IDLE_CLOCK.cooldownMaxMs, cooldownMinMs, 7 * 24 * 60 * 60 * 1000);
  return {
    enabled: src.enabled === true,
    checkIntervalMs,
    minIdleMs,
    scaleHours: clampNumber(src.scaleHours, DEFAULT_IDLE_CLOCK.scaleHours, 0.25, 24),
    shape: clampNumber(src.shape, DEFAULT_IDLE_CLOCK.shape, 0.25, 6),
    cooldownMinMs,
    cooldownMaxMs,
  };
}

/** 累计概率：空闲 t 小时，至少已触发过一次的概率。 */
export function cumulativeProbability(idleMs, { scaleHours = 3, shape = 2 } = {}) {
  const hours = Math.max(0, Number(idleMs) || 0) / 3_600_000;
  const scale = Math.min(24, Math.max(0.25, Number(scaleHours) || 3));
  const power = Math.min(6, Math.max(0.25, Number(shape) || 2));
  return 1 - Math.exp(-Math.pow(hours / scale, power));
}

/** 单次检查的条件概率（由累计概率的增量换算）。 */
export function checkProbability(idleMs, checkIntervalMs, { scaleHours = 3, shape = 2 } = {}) {
  const now = Math.max(0, Number(idleMs) || 0);
  const dt = Math.max(1, Number(checkIntervalMs) || DEFAULT_IDLE_CLOCK.checkIntervalMs);
  const before = cumulativeProbability(now, { scaleHours, shape });
  const after = cumulativeProbability(now + dt, { scaleHours, shape });
  const denom = Math.max(1e-9, 1 - before);
  return Math.min(1, Math.max(0, (after - before) / denom));
}

export function nextEligibleAt(now, config = DEFAULT_IDLE_CLOCK, random = Math.random) {
  const cfg = normalizeIdleClock(config);
  const r = Math.min(1, Math.max(0, Number(random()) || 0));
  const gap = cfg.cooldownMinMs + r * Math.max(0, cfg.cooldownMaxMs - cfg.cooldownMinMs);
  return Number(now) + Math.round(gap);
}

export function shouldTriggerIdle({
  now = Date.now(),
  lastConversationAt = 0,
  nextEligibleAt: eligibleAt = 0,
  config = DEFAULT_IDLE_CLOCK,
  random = Math.random,
} = {}) {
  const cfg = normalizeIdleClock(config);
  const at = Number(now) || Date.now();
  const last = Number(lastConversationAt) > 0 ? Number(lastConversationAt) : at;
  const idleMs = Math.max(0, at - last);
  if (!cfg.enabled) return { fire: false, reason: 'disabled', idleMs, probability: 0 };
  if (idleMs < cfg.minIdleMs) return { fire: false, reason: 'min-idle', idleMs, probability: 0 };
  if (Number(eligibleAt) > at) return { fire: false, reason: 'cooldown', idleMs, probability: 0 };
  const probability = checkProbability(idleMs, cfg.checkIntervalMs, cfg);
  const roll = Math.min(1, Math.max(0, Number(random()) || 0));
  if (roll < probability) return { fire: true, reason: 'due', idleMs, probability };
  return { fire: false, reason: 'roll', idleMs, probability };
}

export function humanDuration(ms) {
  const mins = Math.max(0, Math.round((Number(ms) || 0) / 60_000));
  if (mins < 60) return `${mins} 分钟`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}
