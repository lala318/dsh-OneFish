#!/usr/bin/env node
/**
 * DSH 会话适配层回归：用假 controller 验证 create/rename/history/archive 的调用形状。
 */
import assert from 'node:assert/strict';
import { createDshSessionAdapter } from '../lib/dsh/session-adapter.js';

const calls = { create: [], rename: [], events: [], archive: [] };
const controller = {
  async create(request) {
    calls.create.push(request);
    return { sessionId: 'session-adapter-1', agentPreset: request.agentPreset };
  },
  async rename(request) {
    calls.rename.push(request);
    return { title: request.title, seq: 1 };
  },
  async events(request, signal) {
    calls.events.push(request);
    assert.ok(signal, 'sessionController.events 必须收到 AbortSignal');
    if (request.beforeSeq === undefined) {
      return {
        cursor: 11,
        hasMore: true,
        records: [
          { event: { type: 'user/message', seq: 10, data: { role: 'user', content: 'new' } } },
          { event: { type: 'assistant/message', seq: 11, data: { message: { role: 'assistant', content: 'ok' } } } },
        ],
      };
    }
    return {
      cursor: 11,
      hasMore: false,
      records: [
        { event: { type: 'user/message', seq: 1, data: { role: 'user', content: 'old' } } },
      ],
    };
  },
};
const workspaceRegistry = {
  async archiveSession(sessionId) { calls.archive.push(sessionId); },
};

const adapter = createDshSessionAdapter({
  sessionController: controller,
  workspaceRegistry,
  historyPageMessages: 2,
  historyMaxPages: 5,
});

const created = await adapter.createDaily({ preset: 'onefish-core', title: 'OneFish 2026-11-13', day: '2026-11-13' });
assert.deepEqual(created, { sessionId: 'session-adapter-1', preset: 'onefish-core' });
assert.deepEqual(calls.create, [{ agentPreset: 'onefish-core' }]);
assert.deepEqual(calls.rename, [{ sessionId: 'session-adapter-1', title: 'OneFish 2026-11-13' }]);

const records = await adapter.history('session-adapter-1');
assert.equal(records.length, 3);
assert.deepEqual(calls.events.map((item) => item.beforeSeq), [undefined, 10]);
assert.equal(calls.events[0].maxMessages, 2);
assert.equal(calls.events[0].address.kind, 'session');
assert.equal(calls.events[0].address.sessionId, 'session-adapter-1');

await adapter.archive('session-adapter-1');
assert.deepEqual(calls.archive, ['session-adapter-1']);

console.log('✅ DSH 会话适配层测试通过');
