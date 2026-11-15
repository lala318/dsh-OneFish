/**
 * 记忆遗忘曲线：重要、常被用、越核心的记忆衰减越慢。
 *
 * retention = exp(-ageDays / stabilityDays)
 * stabilityDays = base * importanceFactor * (1 + useCount * 0.35)
 */
const DAY = 86400000;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function lastTouchOf(entry) {
  return Math.max(
    Number(entry?.lastUsedAt) || 0,
    Number(entry?.updatedAt) || 0,
    Number(entry?.createdAt) || 0,
  );
}

export function stabilityDaysOf(entry, { baseDays = 14 } = {}) {
  const importance = clamp(Number(entry?.importance) || 3, 1, 5);
  const useCount = Math.max(0, Number(entry?.useCount) || 0);
  const tierFactor = entry?.tier === 'core' ? 4 : entry?.tier === 'knowledge' ? 1.4 : 1;
  return Math.max(1, baseDays * (0.5 + importance * 0.35) * (1 + Math.min(10, useCount) * 0.35) * tierFactor);
}

export function retentionOf(entry, { now = Date.now(), baseDays = 14 } = {}) {
  const last = lastTouchOf(entry);
  if (!last) return 1;
  const ageDays = Math.max(0, (Number(now) - last) / DAY);
  const stability = stabilityDaysOf(entry, { baseDays });
  return clamp(Math.exp(-ageDays / stability), 0, 1);
}

export function memoryScore(entry, { now = Date.now(), baseDays = 14 } = {}) {
  const importance = clamp((Number(entry?.importance) || 3) / 5, 0, 1);
  const retention = retentionOf(entry, { now, baseDays });
  const use = Math.min(1, (Number(entry?.useCount) || 0) / 12);
  const recency = clamp(1 - Math.max(0, (now - lastTouchOf(entry)) / DAY) / 365, 0, 1);
  return 0.4 * importance + 0.4 * retention + 0.15 * use + 0.05 * recency;
}

export function shouldBeDormant(entry, { now = Date.now(), minRetention = 0.06 } = {}) {
  if (!entry || entry.tier !== 'active') return false;
  if ((Number(entry.importance) || 0) >= 5) return false;
  return retentionOf(entry, { now }) < minRetention;
}

export function decayPatch(entry, { now = Date.now(), baseDays = 14 } = {}) {
  return {
    retention: retentionOf(entry, { now, baseDays }),
    stabilityDays: stabilityDaysOf(entry, { baseDays }),
    lastDecayAt: now,
    dormant: shouldBeDormant(entry, { now }),
  };
}
