#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  API_VERSION,
  MANIFEST_VERSION,
  ComponentManifestError,
  createInbound,
  createOutbound,
  coreVersionSatisfies,
  validateManifest,
} from '../src/index.js';

const manifest = validateManifest({
  manifestVersion: 1,
  id: 'echo',
  name: 'Echo',
  version: '0.1.0',
  apiVersion: 1,
  core: '^0.1.0',
  capabilities: {
    channel: { inbound: true, outbound: 'auto' },
    tools: false,
    jobs: false,
    context: true,
  },
  state: true,
});
assert.equal(manifest.id, 'echo');
assert.equal(manifest.capabilities.channel.outbound, 'auto');
assert.equal(manifest.apiVersion, API_VERSION);
assert.equal(manifest.manifestVersion, MANIFEST_VERSION);

assert.throws(() => validateManifest({ id: 'Bad Id' }), ComponentManifestError);
assert.throws(() => validateManifest({ ...manifest, capabilities: { channel: { outbound: 'bad' } } }), ComponentManifestError);

const inbound = createInbound({
  channelKey: 'echo:test',
  requestId: 'r1',
  text: 'hello',
  user: { id: 'u1', name: 'tester' },
});
assert.equal(inbound.text, 'hello');
assert.equal(inbound.user.id, 'u1');

const outbound = createOutbound({
  componentId: 'echo',
  channelKey: 'echo:test',
  requestId: 'r1',
  kind: 'assistant',
  text: 'ok',
});
assert.equal(outbound.componentId, 'echo');
assert.equal(outbound.kind, 'assistant');

assert.equal(coreVersionSatisfies('0.1.0', '^0.1.0'), true);
assert.equal(coreVersionSatisfies('1.0.0', '^0.1.0'), false);

console.log('✅ Component SDK 测试通过');
