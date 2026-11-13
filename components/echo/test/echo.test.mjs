#!/usr/bin/env node
import assert from 'node:assert/strict';
import { apply, createEchoComponent, MANIFEST } from '../lib/index.js';

const submitted = [];
const listeners = new Set();
const scope = {
  id: 'echo',
  session: {
    ensureToday: async () => ({ sessionId: 'session-echo' }),
    current: () => ({ sessionId: 'session-echo' }),
    submit: async (envelope) => {
      submitted.push(envelope);
      return { requestId: envelope.requestId, sessionId: 'session-echo' };
    },
    onOutbound: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  },
};

const component = createEchoComponent();
assert.equal(component.manifest.id, MANIFEST.id);
await component.start(scope);
assert.equal((await component.health()).status, 'running');

const accepted = await component.submit('hello');
assert.equal(accepted.sessionId, 'session-echo');
assert.equal(submitted.length, 1);
assert.equal(submitted[0].channelKey, 'echo:test');
assert.equal(submitted[0].text, 'hello');
assert.match(component.renderPrompt(submitted[0]), /【Echo】echo:test/);

for (const listener of listeners) {
  listener({ componentId: 'echo', channelKey: 'echo:test', requestId: submitted[0].requestId, kind: 'assistant', text: 'ok' });
}
assert.equal(component.received.length, 1);
assert.equal(component.received[0].text, 'ok');

await component.stop();
assert.equal((await component.health()).status, 'stopped');

let registered = null;
const fakeCtx = {
  onefishCore: {
    components: {
      async register(componentToRegister) { registered = componentToRegister; return { id: 'echo' }; },
    },
  },
};
const handle = await apply(fakeCtx);
assert.deepEqual(handle, { id: 'echo' });
assert.equal(registered.manifest.id, 'echo');

console.log('✅ Echo 组件契约测试通过');
