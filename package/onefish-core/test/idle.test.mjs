#!/usr/bin/env node
import assert from 'node:assert/strict';
import { shouldTriggerIdle, normalizeIdleClock, humanDuration } from '../lib/core/domain/idle-clock.js';
import { createIdleClockService } from '../lib/core/application/idle.js';

const cfg = normalizeIdleClock({
  enabled: true,
  minIdleMs: 60_000,
  checkIntervalMs: 60_000,
  cooldownMinMs: 60_000,
  cooldownMaxMs: 60_000,
});
assert.equal(cfg.enabled, true);
const due = shouldTriggerIdle({
  now: 10 * 60_000,
  lastConversationAt: 1,
  config: cfg,
  random: () => 0,
});
assert.equal(due.fire, true);
assert.equal(humanDuration(90 * 60_000), '1 小时 30 分钟');

let now = 10 * 60_000;
let state = { day: '2026-11-15', countToday: 0, lastConsiderAt: 0, nextEligibleAt: 0, lastIdleMs: 0 };
const prompts = [];
const store = {
  read: () => ({ ...state }),
  write: (patch) => { state = { ...state, ...patch }; return { ...state }; },
};
const idle = createIdleClockService({
  store,
  session: { current: () => ({ sessionId: 's1', day: '2026-11-15', workspaceTitle: 'onefish', lastActivityAt: 1 }) },
  config: { idleClock: cfg, rolloverHour: 4 },
  now: () => now,
  random: () => 0,
  prompt: async ({ sessionId, text }) => { prompts.push({ sessionId, text }); },
});
const status = idle.status();
assert.equal(status.enabled, true);
assert.match(idle.preview().text, /【空闲】/);
const configured = idle.configure({ enabled: true, minIdleMs: 120_000, scaleHours: 2 });
assert.equal(configured.config.minIdleMs, 120_000);
assert.equal(configured.config.scaleHours, 2);
assert.equal(idle.config.minIdleMs, 120_000);
const fired = await idle.check();
assert.equal(fired.fired, true);
assert.equal(prompts.length, 1);
assert.equal(prompts[0].sessionId, 's1');
assert.match(prompts[0].text, /【空闲】/);
assert.equal(state.countToday, 1);
assert.ok(state.nextEligibleAt > now);
const second = await idle.check();
assert.equal(second.fired, false);
assert.equal(second.reason, 'cooldown');

now += 2 * 60 * 60 * 1000;
const beforeManual = { countToday: state.countToday, nextEligibleAt: state.nextEligibleAt };
const manual = await idle.check({ manual: true });
assert.equal(manual.fired, true);
assert.equal(manual.manual, true);
assert.equal(prompts.length, 2);
assert.equal(state.countToday, beforeManual.countToday, '手动触发不该吃掉今天的额度');
assert.equal(state.nextEligibleAt, beforeManual.nextEligibleAt, '手动触发不该进入冷却');
assert.ok(state.lastManualAt > 0, '应该留一个手动触发的痕迹');

// 冷却期内手动仍然可用：它是调试动作，不受概率/冷却约束
const manualAgain = await idle.check({ manual: true });
assert.equal(manualAgain.fired, true);
assert.equal(prompts.length, 3);
assert.equal(state.countToday, beforeManual.countToday, '连着点也不该累计额度');

console.log('✅ 空闲钟测试通过');
