#!/usr/bin/env node
/**
 * DSH 会话适配层回归：用假 controller 验证 workspace/create/rename/history/archive 的调用形状。
 */
import assert from 'node:assert/strict';
import { createDshSessionAdapter } from '../lib/core/adapters/dsh/session-adapter.js';

const calls = { create: [], rename: [], events: [], archive: [], workspaceCreate: [], append: [], attach: [] };
const sessions = {
  get(sessionId) {
    return {
      append(type, data, opts) {
        calls.append.push({ sessionId, type, data, opts });
        return { seq: 42 };
      },
    };
  },
};
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
      sessionIds: [],
      async setTitle(next) { this.title = next; },
      async attachSession(sessionId) {
        calls.attach.push(sessionId);
        if (!this.sessionIds.includes(sessionId)) this.sessionIds.unshift(sessionId);
      },
    };
    return workspace;
  },
  get(id) { return workspace?.id === id ? workspace : undefined; },
  async archiveSession(sessionId, options) { calls.archive.push({ sessionId, options }); },
};

const adapter = createDshSessionAdapter({
  sessionController: controller,
  workspaceRegistry,
  sessions,
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
assert.deepEqual(created, {
  sessionId: 'session-adapter-1',
  preset: 'onefish-core',
  workspaceAttached: true,
  workspaceAttachError: '',
});
assert.deepEqual(calls.create, [{ agentPreset: 'onefish-core', workspaceId: 'workspace-onefish' }]);
assert.deepEqual(calls.attach, ['session-adapter-1']);
assert.ok(workspace.sessionIds.includes('session-adapter-1'));
assert.deepEqual(calls.rename, [{ sessionId: 'session-adapter-1', title: 'OneFish 2026-11-13' }]);

const records = await adapter.history('session-adapter-1');
assert.equal(records.length, 3);
assert.deepEqual(calls.events.map((item) => item.beforeSeq), [undefined, 10]);
assert.equal(calls.events[0].maxMessages, 2);
assert.equal(calls.events[0].address.kind, 'session');
assert.equal(calls.events[0].address.sessionId, 'session-adapter-1');

await adapter.archive('session-adapter-1');
assert.deepEqual(calls.archive, [{ sessionId: 'session-adapter-1', options: { stopActivity: true } }]);

const injected = await adapter.injectContext('session-adapter-1', '【OneFish 开机包】', { turn: 2, step: 3 });
assert.equal(injected.seq, 42);
assert.equal(calls.append.length, 1);
assert.equal(calls.append[0].type, 'developer/message');
assert.equal(calls.append[0].data.turn, 2);
assert.equal(calls.append[0].data.step, 3);
assert.match(calls.append[0].data.message.id, /^[0-9a-f-]{36}$/);
assert.equal(calls.append[0].data.message.role, 'developer');
assert.deepEqual(calls.append[0].data.message.source, { kind: 'onefish-core' });
assert.equal(calls.append[0].data.message.content[0].text, '【OneFish 开机包】');
assert.deepEqual(calls.append[0].opts, { surfaceOp: 'append' });

const skipped = await adapter.injectContext('session-adapter-1', 'no open turn');
assert.equal(skipped.skipped, true);
assert.equal(calls.append.length, 1);

console.log('✅ DSH 会话适配层测试通过');
