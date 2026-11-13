/**
 * 逻辑日：默认 04:00 换日。
 *
 * 为什么不是 00:00：凌晨聊天通常仍属于“昨晚”，04:00 与 OneFish 旧口径一致。
 */
export const DEFAULT_ROLLOVER_HOUR = 4;

function pad(n) {
  return String(n).padStart(2, '0');
}

/** 给定时间戳落在哪个逻辑日（YYYY-MM-DD）。 */
export function dayKeyOf(value = Date.now(), { rolloverHour = DEFAULT_ROLLOVER_HOUR } = {}) {
  const d = new Date(value);
  d.setHours(d.getHours() - rolloverHour);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 逻辑日起点（本地时区）。 */
export function dayStart(dayKey, { rolloverHour = DEFAULT_ROLLOVER_HOUR } = {}) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || ''));
  if (!match) throw new Error(`invalid dayKey: ${dayKey}`);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), rolloverHour, 0, 0, 0).getTime();
}

/** 逻辑日终点（不含）。 */
export function dayEnd(dayKey, options = {}) {
  const start = new Date(dayStart(dayKey, options));
  start.setDate(start.getDate() + 1);
  return start.getTime();
}

/** 两个时间戳是否在同一逻辑日。 */
export function sameDay(a, b, options = {}) {
  return dayKeyOf(a, options) === dayKeyOf(b, options);
}

/** 展示用：2026-11-13 → 2026-11-13。 */
export function normalizeDayKey(dayKey) {
  const text = String(dayKey || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`invalid dayKey: ${dayKey}`);
  return text;
}
