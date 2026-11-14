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

// tool 模式：submit 等待 DSH admission，成功后才返回 accepted。
const toolPrompts = [];
const toolBroker = createDshComponentBroker({
  core,
  sessionController: {
    async prompt(request) {
      toolPrompts.push(request);
      return { accepted: true };
    },
  },
  components: {
    get(id) {
      return id === 'qq' ? {
        manifest: { id: 'qq', capabilities: { channel: { outbound: 'tool' } } },
        component: { renderPrompt: (envelope) => `qq:${envelope.channelKey}` },
      } : null;
    },
    emitOutbound() {},
  },
});
const q1 = await toolBroker.submit('qq', { channelKey: 'private:1', requestId: 'q1', text: '第一条' });
const q2 = await toolBroker.submit('qq', { channelKey: 'private:1', requestId: 'q2', text: '第二条' });
assert.equal(q1.accepted, true);
assert.equal(q2.accepted, true);
assert.equal(toolPrompts.length, 2);
assert.equal(toolPrompts[0].requestId, 'q1');
assert.equal(toolPrompts[1].requestId, 'q2');

// tool 模式 prompt 失败必须 reject，不能静默接受。
let failNext = true;
const failBroker = createDshComponentBroker({
  core,
  sessionController: {
    async prompt() {
      if (failNext) throw new Error('prompt rejected');
      return { accepted: true };
    },
  },
  components: {
    get(id) {
      return id === 'qq' ? {
        manifest: { id: 'qq', capabilities: { channel: { outbound: 'tool' } } },
        component: {},
      } : null;
    },
    emitOutbound() {},
  },
});
await assert.rejects(
  () => failBroker.submit('qq', { channelKey: 'private:1', requestId: 'fail-1', text: '会失败' }),
  /prompt rejected/,
);
failNext = false;
const recovered = await failBroker.submit('qq', { channelKey: 'private:1', requestId: 'retry-1', text: '重试' });
assert.equal(recovered.accepted, true);

// 组件 body 只能作为附加块；Core 始终保留频道/来源/用户/消息。
const compactPrompts = [];
const compactBroker = createDshComponentBroker({
  core,
  sessionController: {
    async prompt(request) {
      compactPrompts.push(request);
      return { accepted: true };
    },
  },
  components: {
    get(id) {
      return id === 'qq' ? {
        manifest: { id: 'qq', capabilities: { channel: { outbound: 'tool' } } },
        component: { renderPrompt: () => '【QQ 私聊 1｜未读 1】' },
      } : null;
    },
    emitOutbound() {},
  },
});
await compactBroker.submit('qq', {
  channelKey: 'private:1',
  requestId: 'compact-1',
  text: 'hi',
  meta: { promptOwnMessage: true },
});
assert.match(compactPrompts[0].content[0].text, /【频道】private:1/);
assert.match(compactPrompts[0].content[0].text, /【来源】qq/);
assert.match(compactPrompts[0].content[0].text, /【QQ 私聊 1｜未读 1】/);
assert.match(compactPrompts[0].content[0].text, /【消息】hi/);

console.log('✅ 组件消息 broker 测试通过');
