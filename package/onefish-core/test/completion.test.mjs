#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createDshCompletion } from '../lib/core/adapters/dsh/completion.js';

const archived = [];
const controller = {
  async create() { return { sessionId: 'memory-session-1' }; },
  async rename() {},
  async prompt(request) {
    assert.equal(request.sessionId, 'memory-session-1');
    assert.match(request.content[0].text, /记忆整理器/);
  },
  async events() {
    return {
      records: [{
        event: {
          type: 'assistant/message',
          data: { message: { role: 'assistant', content: [{ type: 'text', text: '{"ops":[]}' }] } },
        },
      }],
    };
  },
};
const workspaceRegistry = {
  async resolveByPath() { return { id: 'ws-1' }; },
  async archiveSession(sessionId) { archived.push(sessionId); },
};
const completion = createDshCompletion({ sessionController: controller, workspaceRegistry, cwd: 'C:/tmp', logger: () => {} });
const text = await completion.complete({ system: '你是记忆整理器', user: '整理今天' });
assert.equal(text, '{"ops":[]}');
assert.deepEqual(archived, ['memory-session-1']);
console.log('✅ DSH 记忆整理补全测试通过');
