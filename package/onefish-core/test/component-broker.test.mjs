#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createDshComponentBroker } from '../lib/core/adapters/dsh/component-broker.js';

const prompts = [];
const outbound = [];
const sessionController = {
  async prompt(request) {
    prompts.push(request);
    return { accepted: true };
  },
};
const core = {
  session: {
    async ensureToday() { return { sessionId: 's1' }; },
    current() { return { sessionId: 's1' }; },
  },
};
const components = {
  get(id) {
    return id === 'echo' ? {
      manifest: { id: 'echo', capabilities: { channel: { outbound: 'auto' } } },
      component: { renderPrompt: (envelope) => `echo:${envelope.channelKey}` },
    } : null;
  },
  emitOutbound(id, event) { outbound.push({ id, event }); },
};

const broker = createDshComponentBroker({ core, sessionController, components });
const accepted = await broker.submit('echo', {
  channelKey: 'echo:test',
  requestId: 'r1',
  text: 'hello',
  replyTo: 'm0',
});
assert.equal(accepted.sessionId, 's1');
assert.equal(prompts.length, 1);
assert.match(prompts[0].content[0].text, /【频道】echo:test/);
assert.match(prompts[0].content[0].text, /echo:echo:test/);
assert.match(prompts[0].content[0].text, /【消息】hello/);

broker.handleEvent({ id: 's1' }, { type: 'turn/start', data: { turnId: 't1' } });
broker.handleEvent({ id: 's1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ok' }] } } });
broker.handleEvent({ id: 's1' }, { type: 'turn/end' });
assert.equal(outbound.length, 1);
assert.equal(outbound[0].id, 'echo');
assert.equal(outbound[0].event.text, 'ok');
assert.equal(outbound[0].event.replyTo, 'm0');

// 第二个请求排队，turn/end 后才发下一条 prompt
await broker.submit('echo', { channelKey: 'echo:test', requestId: 'r2', text: 'second' });
assert.equal(prompts.length, 2);
broker.handleEvent({ id: 's1' }, { type: 'turn/start', data: { turnId: 't2' } });
broker.handleEvent({ id: 's1' }, { type: 'turn/end' });
assert.equal(outbound.length, 2);

console.log('✅ 组件消息 broker 测试通过');
