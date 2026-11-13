#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createComponentRegistry } from '../lib/core/application/components.js';

const submitted = [];
const scopeEvents = [];
const core = {
  session: {
    ensureToday: async () => ({ sessionId: 's1' }),
    current: () => ({ day: '2026-11-13', sessionId: 's1' }),
    status: () => ({ stats: { currentDay: '2026-11-13' } }),
  },
  persona: {
    get: () => ({ name: 'Test', text: 'persona' }),
    list: () => [],
    update: () => ({}),
    block: () => 'persona block',
  },
  memory: {
    search: () => [],
    add: () => ({}),
    update: () => ({}),
    remove: () => ({}),
    list: () => [],
    blocks: () => ({ core: '', active: '' }),
  },
  bootPack: { build: () => 'boot' },
  config: { components: { demo: { x: 1 } } },
};
const componentStore = { ensure: (id) => `C:/state/${id}`, dir: (id) => `C:/state/${id}` };

const registry = createComponentRegistry({ core, componentStore, config: core.config, version: '0.1.0' });
registry.setSubmit(async (componentId, envelope) => {
  submitted.push({ componentId, envelope });
  return { requestId: envelope.requestId, sessionId: 's1' };
});

let started = false;
const component = {
  manifest: {
    manifestVersion: 1,
    id: 'demo',
    name: 'Demo',
    version: '0.1.0',
    apiVersion: 1,
    core: '^0.1.0',
    capabilities: { channel: { inbound: true, outbound: 'auto' }, context: true },
    state: true,
  },
  async start(scope) {
    started = true;
    assert.equal(scope.id, 'demo');
    assert.deepEqual(scope.config, { x: 1 });
    scope.session.onOutbound((event) => scopeEvents.push(event));
    const result = await scope.session.submit({ channelKey: 'demo:test', requestId: 'r1', text: 'hi' });
    assert.equal(result.sessionId, 's1');
  },
  async stop() {},
  async health() { return { ok: true }; },
};

const handle = await registry.register(component);
assert.equal(started, true);
assert.equal(handle.id, 'demo');
assert.equal(handle.status, 'running');
assert.equal(submitted.length, 1);
assert.equal(submitted[0].componentId, 'demo');
assert.equal(registry.emitOutbound('demo', { text: 'ok' }), 1);
assert.equal(scopeEvents.length, 1);
assert.equal(registry.list().length, 1);
assert.equal(registry.health('demo').status, 'running');
assert.equal(await registry.stop('demo'), true);
assert.equal(registry.health('demo').status, 'stopped');

await assert.rejects(() => registry.register(component), /already registered/);

console.log('✅ 组件注册表测试通过');
