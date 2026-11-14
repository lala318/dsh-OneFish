#!/usr/bin/env node
/**
 * 开机包内容回归：人格卡 / core / active / 昨日摘要 / DSH 使用说明。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCore } from '../lib/core/index.js';

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
    workspace: { workspaceTitle: 'onefish', workspacePath: 'C:/Users/lala/.dsh/OneFish' },
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

  console.log('✅ 开机包测试通过');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
