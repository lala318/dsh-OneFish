#!/usr/bin/env node
/**
 * 每轮记忆召回回归：打分兜底、跳过规则、注入时机与去重。
 * 用真实 core（临时 home）+ 假 DSH 适配器，不联网。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCore } from '../lib/core/index.js';
import { queryTokens, lexicalRelevance, userMessageText } from '../lib/core/application/recall.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'onefish-recall-test-'));
process.on('exit', () => {
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
});
const now = new Date(2026, 10, 19, 22, 50, 0, 0).getTime();

function makeAdapter() {
  return {
    injected: [],
    async ensureWorkspace({ path: workspacePath, title }) {
      return { workspaceId: 'workspace-onefish', workspaceTitle: title, workspacePath };
    },
    async createDaily({ preset, day }) {
      return { sessionId: 'session-recall-1', preset: preset || 'onefish-core', day, workspaceAttached: true, workspaceAttachError: '' };
    },
    async injectContext(sessionId, text, options = {}) {
      this.injected.push({ sessionId, text, options });
      return { seq: this.injected.length };
    },
    async history() { return []; },
    async archive() {},
  };
}

function createTestCore(adapter, config = {}) {
  return createCore({
    home: temp,
    repoRoot: path.resolve(import.meta.dirname, '../..'),
    sessionAdapter: adapter,
    now: () => now,
    config: {
      autoConsolidate: false,
      consolidateOnBootstrap: false,
      rolloverHour: 4,
      workspacePath: temp,
      workspaceTitle: 'onefish',
      ...config,
    },
  });
}

test('词面兜底打分：中文二元组 + 英文词，标签也算命中', () => {
  const tokens = queryTokens('考研数一 2027');
  assert.ok(tokens.includes('考研'));
  assert.ok(tokens.includes('数一'));
  assert.ok(tokens.includes('2027'));

  const hit = lexicalRelevance(tokens, { text: '2027 年 12 月考研，数学考数一', tags: ['考研'] });
  assert.ok(hit > 0.5, `相关记忆得分应该够高，实际 ${hit}`);
  const miss = lexicalRelevance(tokens, { text: '今天中午吃的是西红柿炒鸡蛋', tags: ['吃饭'] });
  assert.equal(miss, 0);
});

test('userMessageText：从 DSH user/message data 取文本', () => {
  assert.equal(userMessageText({ data: { role: 'user', content: [{ type: 'text', text: '早上好' }] } }), '早上好');
  assert.equal(userMessageText({ data: { content: [{ type: 'text', text: 'A' }, { type: 'image' }, { type: 'text', text: 'B' }] } }), 'A\nB');
  assert.equal(userMessageText({}), '');
});

test('召回服务：命中注入、短消息/空闲前缀不注入', async () => {
  const adapter = makeAdapter();
  const core = createTestCore(adapter);
  core.memory.add({ text: '主人 2027 年 12 月参加考研，考数一，学校还没定', tier: 'active', kind: 'fact', tags: ['考研', '学业'] });
  core.memory.add({ text: '今天中午吃的是西红柿炒鸡蛋', tier: 'active', kind: 'fact', tags: ['吃饭'] });

  const ok = await core.recall.build({ text: '考研数一 2027 还剩多少时间' });
  assert.equal(ok.reason, 'ok');
  assert.match(ok.text, /【记忆召回】/);
  assert.match(ok.text, /2027 年 12 月/);
  assert.ok(ok.items.length <= 3);
  assert.ok(!ok.text.includes('西红柿炒鸡蛋'), '无关记忆不该被召回');

  assert.equal((await core.recall.build({ text: '嗯' })).reason, 'short');
  const brief = await core.recall.build({ text: '考研数一' });
  assert.equal(brief.reason, 'ok', '4 字短消息也应能触发召回');
  assert.match(brief.text, /考研/);
  assert.match((await core.recall.build({ text: '【空闲】现在是 2026-11-19 22:50' })).reason, /^prefix:/);
});

test('召回服务：关闭后不产出', async () => {
  const adapter = makeAdapter();
  const core = createTestCore(adapter, { recall: { enabled: false } });
  core.memory.add({ text: '主人 2027 年 12 月参加考研', tier: 'active', kind: 'fact' });
  const built = await core.recall.build({ text: '考研的事，2027 年才考对吧' });
  assert.equal(built.reason, 'disabled');
  assert.equal(built.text, '');
});

test('召回服务：词面兜底阈值太高时不注入', async () => {
  const adapter = makeAdapter();
  const core = createTestCore(adapter, { recall: { lexicalMinScore: 0.99, minScore: 0.99 } });
  core.memory.add({ text: '主人 2027 年 12 月参加考研，考数一', tier: 'active', kind: 'fact' });
  const built = await core.recall.build({ text: '考研数一 2027 还剩多少时间' });
  assert.equal(built.reason, 'no-hit');
});

test('会话注入：user/message 落到当前 open step；同轮只注入一次；首轮跳过', async () => {
  const adapter = makeAdapter();
  const core = createTestCore(adapter);
  core.memory.add({ text: '主人 2027 年 12 月参加考研，数学考数一', tier: 'active', kind: 'fact', tags: ['考研'] });
  const entry = await core.session.ensureToday();
  const id = entry.sessionId;

  // 首轮：system/message → 开机包；user/message 不召回
  await core.session.handleEvent(id, { type: 'system/message', data: { turn: 1, step: 1 } });
  await core.session.handleEvent(id, { type: 'step/start', data: { turn: 1, step: 1 } });
  await core.session.handleEvent(id, { type: 'user/message', data: { content: [{ type: 'text', text: '考研数一 2027 怎么安排' }] } });
  assert.equal(adapter.injected.filter((item) => item.text.includes('【记忆召回】')).length, 0, '首轮不召回');

  // 第二轮：先 step/start 打开 turn 2，再来用户消息
  const before = adapter.injected.length;
  await core.session.handleEvent(id, { type: 'step/start', data: { turn: 2, step: 1 } });
  await core.session.handleEvent(id, { type: 'user/message', data: { content: [{ type: 'text', text: '考研数一 2027 怎么安排' }] } });
  const recalls = adapter.injected.slice(before).filter((item) => item.text.includes('【记忆召回】'));
  assert.equal(recalls.length, 1, '第二轮应该注入一次召回');
  assert.equal(recalls[0].options.turn, 2);
  assert.equal(recalls[0].options.step, 1);
  assert.match(recalls[0].text, /2027 年 12 月/);

  // 同一轮第二句：不再注入
  await core.session.handleEvent(id, { type: 'user/message', data: { content: [{ type: 'text', text: '2027 考研数一真题什么时候开始刷' }] } });
  const after = adapter.injected.filter((item) => item.text.includes('【记忆召回】'));
  assert.equal(after.length, 1, '同一轮只召回一次');
});

test('会话注入：没有 open step 时安静跳过，不抛错', async () => {
  const adapter = makeAdapter();
  const core = createTestCore(adapter);
  core.memory.add({ text: '主人 2027 年 12 月参加考研，数学考数一', tier: 'active', kind: 'fact', tags: ['考研'] });
  const entry = await core.session.ensureToday();
  const result = await core.session.handleEvent(entry.sessionId, {
    type: 'user/message',
    data: { content: [{ type: 'text', text: '考研数一 2027 怎么安排' }] },
  });
  assert.equal(result, null);
  assert.equal(adapter.injected.length, 0);
});

test('会话注入：注入失败只记录，不影响事件处理', async () => {
  const adapter = makeAdapter();
  adapter.injectContext = async () => { throw new Error('session append failed'); };
  const core = createTestCore(adapter);
  core.memory.add({ text: '主人 2027 年 12 月参加考研，数学考数一', tier: 'active', kind: 'fact', tags: ['考研'] });
  const entry = await core.session.ensureToday();
  await core.session.handleEvent(entry.sessionId, { type: 'step/start', data: { turn: 2, step: 1 } });
  const result = await core.session.handleEvent(entry.sessionId, {
    type: 'user/message',
    data: { content: [{ type: 'text', text: '考研数一 2027 怎么安排' }] },
  });
  assert.equal(result, null);
  const state = core.session.current();
  assert.match(String(state.lastRecallError || ''), /session append failed/);
});
