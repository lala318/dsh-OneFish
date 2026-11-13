#!/usr/bin/env node
/**
 * DSH 会话适配层回归：用假 controller 验证 workspace/create/rename/history/archive 的调用形状。
 */
import assert from 'node:assert/strict';
import { createDshSessionAdapter } from '../lib/dsh/session-adapter.js';

const calls = { create: [], rename: [], events: [], archive: [], workspaceCreate: [] };
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

let workspace = null;
const workspaceRegistry = {
  async resolveByPath(path) {
    return workspace?.path === path ? workspace : undefined;
  },
  async create(path, title) {
    calls.workspaceCreate.push({ path, title });
    workspace = {
      id: 'workspace-onefish',
      path,
      title,
      async setTitle(next) { this.title = next; },
    };
    return workspace;
  },
  get(id) { return workspace?.id === id ? workspace : undefined; },
  async archiveSession(sessionId, options) { calls.archive.push({ sessionId, options }); },
};

const adapter = createDshSessionAdapter({
  sessionController: controller,
  workspaceRegistry,
  historyPageMessages: 2,
  historyMaxPages: 5,
});

const ws = await adapter.ensureWorkspace({ path: 'C:/Users/lala/.dsh/OneFish', title: 'onefish' });
assert.deepEqual(ws, {
  workspaceId: 'workspace-onefish',
  workspaceTitle: 'onefish',
  workspacePath: 'C:/Users/lala/.dsh/OneFish',
});
assert.deepEqual(calls.workspaceCreate, [{ path: 'C:/Users/lala/.dsh/OneFish', title: 'onefish' }]);
assert.equal(workspace.title, 'onefish');

const created = await adapter.createDaily({
  preset: 'onefish-core',
  title: 'OneFish 2026-11-13',
  day: '2026-11-13',
  workspaceId: 'workspace-onefish',
});
assert.deepEqual(created, { sessionId: 'session-adapter-1', preset: 'onefish-core' });
assert.deepEqual(calls.create, [{ agentPreset: 'onefish-core', workspaceId: 'workspace-onefish' }]);
assert.deepEqual(calls.rename, [{ sessionId: 'session-adapter-1', title: 'OneFish 2026-11-13' }]);

const records = await adapter.history('session-adapter-1');
assert.equal(records.length, 3);
assert.deepEqual(calls.events.map((item) => item.beforeSeq), [undefined, 10]);
assert.equal(calls.events[0].maxMessages, 2);
assert.equal(calls.events[0].address.kind, 'session');
assert.equal(calls.events[0].address.sessionId, 'session-adapter-1');

await adapter.archive('session-adapter-1');
assert.deepEqual(calls.archive, [{ sessionId: 'session-adapter-1', options: { stopActivity: true } }]);

console.log('✅ DSH 会话适配层测试通过');
