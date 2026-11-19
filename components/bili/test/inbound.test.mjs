#!/usr/bin/env node
/**
 * B站组件入站回归：基线 → 新私信/新评论才 submit → 水位防重复。
 * 用注入的假 client/dm/comments，不联网。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBiliComponent, MANIFEST } from '../lib/index.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'onefish-bili-inbound-'));
process.on('exit', () => {
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
});

function writeCreds(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({
    sessdata: 'S', bili_jct: 'J', buvid3: 'B', mid: '4242', name: '鱼',
  }), 'utf8');
}

function makeScope(dir, submitted) {
  return {
    stateDir: dir,
    config: { owner: { mid: '9001' } },
    session: {
      async submit(envelope) {
        submitted.push(envelope);
        return { sessionId: 'session-test' };
      },
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('manifest：channel inbound + tool 出站', () => {
  assert.equal(MANIFEST.id, 'bili');
  assert.equal(MANIFEST.capabilities.channel.inbound, true);
  assert.equal(MANIFEST.capabilities.channel.outbound, 'tool');
});

test('首轮只记基线；新私信提交一次；重复轮询不再提交', async () => {
  const dir = path.join(temp, 'dm');
  writeCreds(dir);
  const submitted = [];
  const state = {
    sessions: [{ mid: '9001', name: '主人', ts: 1000, unread: 0, lastFromSelf: false, system: false, lastText: '旧的' }],
  };
  const component = createBiliComponent({
    logger: () => {},
    now: () => 10_000_000,
    createClient: () => ({ self: { mid: '4242' } }),
    createDm: () => ({
      async sessions() { return state.sessions; },
      async messages() { return []; },
      canSend() { return { ok: true, reason: 'owner' }; },
      async send() { return { ok: true }; },
    }),
    createComments: () => ({
      async pullInbox() { return { items: [], lastView: 0 }; },
      async resolveLatestReply() { return null; },
    }),
  });

  await component.start(makeScope(dir, submitted));
  await sleep(30);
  assert.equal(submitted.length, 0, '首轮是基线，不提交历史消息');

  state.sessions = [{ mid: '9001', name: '主人', ts: 2000, unread: 1, lastFromSelf: false, system: false, lastText: '在吗' }];
  await component.pollOnce();
  assert.equal(submitted.length, 1, '新私信应提交');
  assert.equal(submitted[0].channelKey, 'dm:9001');
  assert.match(submitted[0].text, /在吗/);
  assert.equal(submitted[0].meta.wakeReason, 'dm');

  await component.pollOnce();
  assert.equal(submitted.length, 1, '同一时间戳不应重复提交');

  const health = await component.health();
  assert.equal(health.started, true);
  assert.equal(health.counters.dmSubmitted, 1);
  await component.stop();
});

test('新评论提交一次，channelKey 用 oid，meta 带 root/parent', async () => {
  const dir = path.join(temp, 'comment');
  writeCreds(dir);
  const submitted = [];
  const commentState = { kind: 'reply', items: [] };
  const component = createBiliComponent({
    logger: () => {},
    now: () => 10_000_000,
    createClient: () => ({ self: { mid: '4242' } }),
    createDm: () => ({ async sessions() { return []; } }),
    createComments: () => ({
      async pullInbox(kind) {
        return { items: kind === commentState.kind ? commentState.items : [], lastView: 0 };
      },
      async resolveLatestReply() {
        return { rpid: '555', text: '真正的回复正文', ctime: 3000, exact: true };
      },
    }),
  });

  await component.start(makeScope(dir, submitted));
  await sleep(30);
  assert.equal(submitted.length, 0, '基线不提交');

  commentState.items = [{
    kind: 'reply', id: 'c1', t: 3000, who: '路人', mid: '7777',
    title: '不可靠的标题', source: '', business: 1, oid: '12345', root: '500', parent: '555', uri: '',
  }];
  await component.pollOnce();
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].channelKey, 'comment:12345');
  assert.match(submitted[0].text, /真正的回复正文/, '正文以回读楼层为准');
  assert.equal(submitted[0].meta.root, '500');
  assert.equal(submitted[0].meta.parent, '555');
  assert.equal(submitted[0].meta.oid, '12345');
  await component.stop();
});

test('renderPrompt：私信与评论都给到工具入口', () => {
  const component = createBiliComponent({ logger: () => {} });
  const dmPrompt = component.renderPrompt({ channelKey: 'dm:9001', receivedAt: 1000, user: { name: '主人' }, meta: { wakeReason: 'dm' } });
  assert.match(dmPrompt, /【B站私信/);
  assert.match(dmPrompt, /bili_dm_send\(mid="9001"/);
  assert.match(dmPrompt, /bili_dm_messages/);

  const commentPrompt = component.renderPrompt({
    channelKey: 'comment:12345',
    receivedAt: 1000,
    user: { name: '路人' },
    meta: { wakeReason: 'comment', oid: '12345', root: '500', parent: '555', business: 1 },
  });
  assert.match(commentPrompt, /【B站评论/);
  assert.match(commentPrompt, /bili_comment_reply\(oid="12345"/);
  assert.match(commentPrompt, /bili_comment_thread/);
});
