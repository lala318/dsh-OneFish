#!/usr/bin/env node
/**
 * 归档脱敏测试：token 不应进入 archive/digest。
 */
import assert from 'node:assert/strict';
import { normalizeRecord, buildDigest } from '../lib/core/domain/consolidation.js';
import { redactSecrets, hasSecret } from '../lib/core/domain/redaction.js';

const raw = '调用 qq_send_message(key="group:1", token="abcdefgh12345678")';
assert.equal(hasSecret(raw), true);
assert.equal(redactSecrets(raw).includes('abcdefgh12345678'), false);
assert.match(redactSecrets(raw), /token="\[redacted\]"/);

const legacy = '【发送令牌】KVPm1ZxQIJOSRBYAm9KqvUHj';
assert.equal(hasSecret(legacy), true);
assert.equal(redactSecrets(legacy).includes('KVPm1ZxQIJOSRBYAm9KqvUHj'), false);
assert.match(redactSecrets(legacy), /【发送令牌】\[redacted\]/);

const message = normalizeRecord({
  event: {
    type: 'user/message',
    seq: 1,
    data: { role: 'user', content: raw },
  },
});
assert.ok(message);
assert.equal(hasSecret(message.text), false);

const digest = buildDigest({ day: '2026-11-13', messages: [message] });
assert.equal(hasSecret(digest), false);
assert.equal(digest.includes('abcdefgh12345678'), false);

console.log('✅ 归档脱敏测试通过');
