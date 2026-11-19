#!/usr/bin/env node
/**
 * B站组件基础回归：配置归一化、凭据查找顺序、WBI 签名、私信解析与发送规则。
 * 不联网、不读真实凭据（临时目录 + 假对象）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeConfig, readConfigFile, writeConfigFile, resolveConfigFile, componentConfigFile } from '../lib/config.js';
import { loadCredentials, credentialsStatus, cookieHeader } from '../lib/credentials.js';
import { wbiQuery } from '../lib/http.js';
import { parseDmContent, normalizeSession, createDmApi } from '../lib/dm.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'onefish-bili-test-'));
process.on('exit', () => {
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
});

const cred = { sessdata: 'S', bili_jct: 'J', buvid3: 'B', mid: '4242', name: '鱼' };

test('配置归一化：坏值回退、默认值齐全', () => {
  const cfg = normalizeConfig({
    owner: { mid: 123, name: '' },
    poll: { intervalSec: 1, enabled: false },
    outbound: { maxDmLength: 99999 },
    video: { maxFrames: 99 },
  });
  assert.equal(cfg.owner.mid, '123');
  assert.equal(cfg.owner.name, '主人');
  assert.equal(cfg.poll.intervalSec, 30, '间隔下限 30s');
  assert.equal(cfg.poll.enabled, false);
  assert.equal(cfg.outbound.maxDmLength, 2000, '私信长度上限钳制');
  assert.equal(cfg.video.maxFrames, 16);
});

test('配置文件读写：原子写 + 读回一致', () => {
  const file = path.join(temp, 'config.json');
  const written = writeConfigFile(file, { owner: { mid: '9' } });
  const read = readConfigFile(file);
  assert.equal(read.owner.mid, written.owner.mid);
  assert.equal(componentConfigFile(temp), file);
});

test('resolveConfigFile：env 优先，其次 stateDir/config.json', () => {
  assert.equal(resolveConfigFile('C:\\x', { ONEFISH_COMPONENT_CONFIG_FILE: 'D:\\c.json' }), 'D:\\c.json');
  assert.equal(resolveConfigFile('C:\\x', {}), path.join('C:\\x', 'config.json'));
});

test('凭据：按 stateDir -> 旧路径顺序查找，字段不全跳过', () => {
  const stateDir = fs.mkdtempSync(path.join(temp, 'state-'));
  fs.writeFileSync(path.join(stateDir, 'credentials.json'), JSON.stringify({ sessdata: 'a', bili_jct: 'b', buvid3: 'c', mid: '7' }));
  const found = loadCredentials({ stateDir, home: temp });
  assert.equal(found.mid, '7');
  assert.match(cookieHeader(found), /SESSDATA=a; bili_jct=b; buvid3=c/);

  const brokenDir = fs.mkdtempSync(path.join(temp, 'broken-'));
  fs.writeFileSync(path.join(brokenDir, 'credentials.json'), JSON.stringify({ sessdata: 'a' }));
  assert.equal(loadCredentials({ stateDir: brokenDir, home: path.join(temp, 'nohome') }), null);
  const status = credentialsStatus({ stateDir: brokenDir, home: path.join(temp, 'nohome') });
  assert.equal(status.usable, false);
});

test('WBI 签名：确定性 + 剔除 !\'()* + 带 wts/w_rid', () => {
  const raw = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const query = wbiQuery({ bvid: 'BV1x', cid: '123', qn: 80, fourk: 1, note: "a!b(c)*d" }, { raw, nowSec: 1700000000 });
  assert.match(query, /wts=1700000000/);
  assert.match(query, /w_rid=[0-9a-f]{32}/);
  assert.ok(!query.includes('!'), '剔除 !');
  assert.ok(query.includes('note=abcd'), '剔除 ()* 后保留字母');
  const again = wbiQuery({ bvid: 'BV1x', cid: '123', qn: 80, fourk: 1, note: "a!b(c)*d" }, { raw, nowSec: 1700000000 });
  assert.equal(query, again);
});

test('私信内容解析：JSON 与纯文本都认', () => {
  assert.equal(parseDmContent(JSON.stringify({ content: '在吗' })), '在吗');
  assert.equal(parseDmContent('纯文本'), '纯文本');
  assert.equal(parseDmContent(''), '');
});

test('会话归一化：自己最后发言 / 系统号 / 未读', () => {
  const me = normalizeSession({
    talker_id: '99',
    account_info: { name: '主人' },
    unread_count: 3,
    last_msg: { sender_uid: '4242', timestamp: 100, content: JSON.stringify({ content: 'hi' }) },
  }, '4242');
  assert.equal(me.lastFromSelf, true);
  assert.equal(me.unread, 3);
  assert.equal(me.lastText, 'hi');

  const sys = normalizeSession({ talker_id: '1', last_msg: { timestamp: 1 } }, '4242');
  assert.equal(sys.system, true);
});

function fakeClient({ sessions = [], sendResult = { httpStatus: 200, code: 0, message: '', data: {} } } = {}) {
  return {
    self: { mid: '4242', name: '鱼' },
    calls: [],
    async getJson(url) {
      this.calls.push({ kind: 'get', url });
      return { code: 0, data: { session_list: sessions } };
    },
    async postForm(url, fields) {
      this.calls.push({ kind: 'post', url, fields });
      return sendResult;
    },
  };
}

test('私信发送规则：主人直发、陌生人只回、系统号拒绝、超长拒绝', async () => {
  const sessions = [
    { talker_id: '9001', account_info: { name: '主人' }, last_msg: { sender_uid: '9001', timestamp: Math.floor(Date.now() / 1000) - 60, content: '{}' } },
    { talker_id: '9002', last_msg: { sender_uid: '4242', timestamp: Math.floor(Date.now() / 1000) - 60, content: '{}' } },
  ];
  const client = fakeClient({ sessions });
  const api = createDmApi(client, { config: { owner: { mid: '9001' }, outbound: { maxDmLength: 10 } } });

  const list = await api.sessions();
  assert.equal(list.length, 2);
  assert.equal(api.canSend({ mid: '9001', sessions: list }).ok, true, 'owner 直发');
  assert.equal(api.canSend({ mid: '9002', sessions: list }).ok, false, '自己最后发言不能主动再发');
  assert.equal(api.canSend({ mid: '5', sessions: list }).ok, false, '系统号拒绝');
  assert.equal(api.canSend({ mid: '9999', sessions: list }).ok, false, '没有会话不能开新会话');

  await assert.rejects(() => api.send({ mid: '9001', text: '太长了太长了太长了啦真的' }), /精简/);
  const sent = await api.send({ mid: '9001', text: '短消息' });
  assert.equal(sent.ok, true);
  const post = client.calls.find((c) => c.kind === 'post');
  assert.equal(post.fields['msg[receiver_id]'], '9001');
  assert.match(post.fields['msg[content]'], /短消息/);
});
