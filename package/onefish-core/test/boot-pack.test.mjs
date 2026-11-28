#!/usr/bin/env node
/**
 * 开机包内容回归：人格卡 / core / active / 昨日摘要 / DSH 使用说明。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCore } from '../lib/core/index.js';
import { distillDay } from '../lib/core/application/boot-pack.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'onefish-boot-pack-test-'));
try {
  const core = createCore({ home: temp, repoRoot: path.resolve(import.meta.dirname, '../..') });
  core.persona.update('# 测试人格\n\n说话简短。\n');
  core.memory.add({ text: '身份：我是测试核心', tier: 'core', kind: 'fact' });
  core.memory.add({ text: '偏好：先给结论', tier: 'active', kind: 'preference' });

  core.archive.consolidateDay({
    day: '2026-11-12',
    sessionId: 'session-yesterday',
    records: [
      { event: { type: 'user/message', seq: 1, data: { role: 'user', content: '昨天在重构。' } } },
      { event: { type: 'assistant/message', seq: 2, data: { message: { role: 'assistant', content: '记下了。' } } } },
    ],
  });

  const text = core.bootPack.build({
    day: '2026-11-13',
    workspace: { workspaceTitle: 'onefish', workspacePath: 'C:/work/OneFish' },
  });

  assert.match(text, /【OneFish 开机包】2026-11-13/);
  assert.match(text, /【工作区】onefish/);
  assert.match(text, /【核心记忆】/);
  assert.match(text, /身份：我是测试核心/);
  assert.match(text, /【人格卡】/);
  assert.match(text, /说话简短/);
  assert.match(text, /【主动记忆】/);
  assert.match(text, /偏好：先给结论/);
  assert.match(text, /【昨天 2026-11-12】/);
  assert.match(text, /昨天在重构/);
  assert.match(text, /【使用方式】/);
  assert.ok(text.length >= 200);
  assert.match(text, /消息可能来自 DSH 原生对话窗口或频道组件/);
  assert.match(text, /使用当前可用的频道发送工具/);

  // 昨天很长：大量寒暄 + 一句靠后的要紧话，开机包应挑出要紧话，而不是只取开头。
  const busy = [];
  for (let i = 0; i < 60; i += 1) {
    busy.push({ event: { type: 'user/message', seq: 10 + i, data: { role: 'user', content: i % 2 ? '哈哈哈哈哈哈哈' : `闲聊第 ${i} 句，随便说点别的事情吧` } } });
  }
  busy.push({ event: { type: 'user/message', seq: 100, data: { role: 'user', content: '我决定了，下周五前把召回门槛那个问题修完并提交' } } });
  busy.push({ event: { type: 'assistant/message', seq: 101, data: { message: { role: 'assistant', content: '记下了，周五前我会提醒你。' } } } });
  core.archive.consolidateDay({ day: '2026-11-14', sessionId: 'session-busy', records: busy });
  const busyText = core.bootPack.build({ day: '2026-11-15' });
  assert.match(busyText, /【昨天 2026-11-14】/);
  assert.match(busyText, /我决定了，下周五前把召回门槛/);
  assert.match(busyText, /共 62 条消息/);
  assert.doesNotMatch(busyText, /哈哈哈哈哈哈哈/, '寒暄不该占开机包');
  assert.equal(distillDay([{ role: 'user', text: '嗯' }, { role: 'user', text: '好的' }]), '');

  // 有压缩稿时，开机包用压缩稿，不再挑原文。
  core.archive.writeSummary('2026-11-14', { text: '- 主人决定周五前修完召回门槛\n- 助手答应周五前提醒进度', sourceHash: 'abc' });
  assert.deepEqual(core.archive.readSummary('2026-11-14'), { text: '- 主人决定周五前修完召回门槛\n- 助手答应周五前提醒进度', sourceHash: 'abc' });
  const summaryText = core.bootPack.build({ day: '2026-11-15' });
  assert.match(summaryText, /【昨天 2026-11-14】\n- 主人决定周五前修完召回门槛/);
  assert.doesNotMatch(summaryText, /共 62 条消息/, '有压缩稿时不该再用规则挑重点');
  assert.equal(core.archive.readSummary('2026-11-30'), null);
  // 设置页要看的状态：有压缩稿 → source=summary；压缩失败 → 带原因；成功后失败记录被清掉
  assert.deepEqual(core.bootPack.describe({ day: '2026-11-15' }).source, 'summary');
  assert.equal(core.bootPack.describe({ day: '2026-11-15' }).summary.status, 'done');
  core.archive.writeSummaryError('2026-11-19', 'model timeout');
  const failed = core.bootPack.describe({ day: '2026-11-20' });
  assert.equal(failed.summary.status, 'failed');
  assert.equal(failed.summary.error, 'model timeout');
  assert.notEqual(failed.source, 'summary');
  core.archive.writeSummary('2026-11-19', { text: '- 补上了', sourceHash: 'def' });
  assert.equal(core.archive.summaryStatus('2026-11-19').status, 'done');
  assert.equal(core.bootPack.describe({ day: '2026-11-30' }).summary.status, 'none');

  console.log('✅ 开机包测试通过');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
