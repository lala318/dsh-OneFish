#!/usr/bin/env node
/**
 * 日会话生命周期回归：换日、封存、整理、幂等、归档。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCore } from '../lib/core/index.js';
import { dayKeyOf, dayStart } from '../lib/core/day.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'onefish-session-test-'));
let now = new Date(2026, 10, 13, 12, 0, 0, 0).getTime();

const adapter = {
  createCount: 0,
  historyCalls: 0,
  archived: [],
  async createDaily({ preset, day }) {
    this.createCount += 1;
    return { sessionId: `session-test-${this.createCount}`, preset: preset || 'onefish-core', day };
  },
  async history() {
    this.historyCalls += 1;
    return [
      { event: { type: 'user/message', seq: 1, at: now - 1000, data: { role: 'user', content: [{ type: 'text', text: '今天聊了日会话。' }] } } },
      { event: { type: 'assistant/message', seq: 2, at: now, data: { message: { role: 'assistant', content: [{ type: 'text', text: '记下了。' }] } } } },
    ];
  },
  async archive(sessionId) {
    this.archived.push(sessionId);
  },
};

try {
  // 04:00 逻辑日
  assert.equal(dayKeyOf(new Date(2026, 10, 13, 3, 59).getTime()), '2026-11-12');
  assert.equal(dayKeyOf(new Date(2026, 10, 13, 4, 0).getTime()), '2026-11-13');
  assert.equal(dayStart('2026-11-13'), new Date(2026, 10, 13, 4, 0, 0, 0).getTime());

  const core = createCore({
    home: temp,
    repoRoot: path.resolve(import.meta.dirname, '../..'),
    sessionAdapter: adapter,
    now: () => now,
    config: { autoConsolidate: false, consolidateOnBootstrap: false, rolloverHour: 4 },
  });

  const first = await core.session.ensureToday();
  assert.equal(first.day, '2026-11-13');
  assert.equal(first.sessionId, 'session-test-1');
  assert.equal(first.created, true);
  assert.equal(core.session.stats().active, true);
  assert.equal(core.session.current().status, 'active');
  assert.equal(core.session.stats().day, '2026-11-13');
  assert.equal(adapter.createCount, 1);

  const same = await core.session.ensureToday();
  assert.equal(same.reused, true);
  assert.equal(adapter.createCount, 1);

  core.session.noteActivity('session-test-1', { type: 'user/message' });
  assert.equal(core.session.current().eventCount, 1);

  // 换日：旧会话封存，新会话创建
  now = new Date(2026, 10, 14, 12, 0, 0, 0).getTime();
  const second = await core.session.ensureToday();
  assert.equal(second.day, '2026-11-14');
  assert.equal(second.sessionId, 'session-test-2');
  assert.equal(adapter.createCount, 2);
  assert.equal(core.session.stats().pending, 1);
  assert.equal(core.session.status().recent.find((item) => item.day === '2026-11-13').status, 'pending');

  // 整理旧会话：写档案 + 摘要
  const archived = await core.session.archiveDay('2026-11-13');
  assert.ok(archived.archivedAt);
  assert.deepEqual(adapter.archived, ['session-test-1']);
  const consolidated = await core.session.consolidateDay('2026-11-13');
  assert.equal(consolidated.count, 2);
  assert.equal(adapter.historyCalls, 1);
  assert.ok(fs.existsSync(consolidated.archivePath));
  assert.ok(fs.existsSync(consolidated.digestPath));
  assert.match(core.archive.readDigest('2026-11-13'), /今天聊了日会话/);
  const hits = core.archive.search('日会话');
  assert.ok(hits.some((hit) => hit.role === 'user' && /日会话/.test(hit.text)));
  assert.equal(core.session.stats().pending, 0);
  assert.equal(core.session.stats().consolidated, 1);
  assert.deepEqual(core.archive.listDays(), ['2026-11-13']);

  // 幂等：不重复读历史
  const again = await core.session.consolidateDay('2026-11-13');
  assert.equal(again.skipped, true);
  assert.equal(adapter.historyCalls, 1);

  // 回收：归档当前会话，状态转 retired
  const retired = await core.session.retire('session-test-2');
  assert.equal(retired.status, 'retired');
  assert.deepEqual(adapter.archived, ['session-test-1', 'session-test-2']);
  assert.equal(core.session.stats().active, false);
  assert.equal(core.session.stats().retired, 1);

  console.log('✅ 日会话生命周期测试通过');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
