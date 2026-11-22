#!/usr/bin/env node
/**
 * 记忆升级回归：遗忘曲线、向量检索、夜间维护。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCore } from '../lib/core/index.js';
import { createMemoryStore } from '../lib/core/adapters/fs/memory-store.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'onefish-memory-test-'));
try {
  const core = createCore({ home: temp, repoRoot: path.resolve(import.meta.dirname, '../..') });
  const first = core.memory.add({ text: '主人喜欢先给结论再补理由', tier: 'active', kind: 'preference', importance: 4 });
  const second = core.memory.add({ text: '项目 OneFish 正在做记忆向量索引', tier: 'active', kind: 'project', importance: 3 });
  const coreMemory = core.memory.add({ text: '身份：我是 OneFish', tier: 'core', kind: 'fact' });

  const health = core.memory.health();
  assert.equal(health.total, 3);
  assert.ok(health.vector);
  assert.ok(health.vector.count >= 3 || health.vector.count === 0);

  const hits = await core.memory.search('记忆向量', { k: 5 });
  assert.ok(hits.some((hit) => hit.id === second.id));

  const block = core.memory.blocks();
  assert.match(block.active, /主人喜欢先给结论/);
  assert.match(block.core, /我是 OneFish/);

  const maintained = await core.memory.maintain({ day: '2026-11-15' });
  assert.equal(maintained.ok, true);
  assert.ok(maintained.indexed.total >= 3);
  const index = path.join(core.memory.resolveDirs().spaceDir, 'vectors', 'index.jsonl');
  assert.ok(fs.existsSync(index));
  assert.match(core.memory.resolveDirs().spaceDir.replaceAll('\\', '/'), /\/memory$/);
  assert.ok(core.memory.list().every((row) => typeof row.retention === 'number'));

  // P1：模型输出的 ops 经过校验后落库。
  const consolidated = core.memory.applyConsolidation({
    day: '2026-11-15',
    text: JSON.stringify({
      ops: [{
        op: 'add',
        tier: 'active',
        kind: 'preference',
        text: '主人夜间整理记忆时不需要人工逐条审计',
        confidence: 0.8,
        sourceDays: ['2026-11-15'],
      }],
    }),
  });
  assert.equal(consolidated.ok, true);
  assert.equal(consolidated.applied.length, 1);
  const prompt = core.memory.consolidationPrompt({ day: '2026-11-15', digest: '# 今天' });
  assert.match(prompt.system, /记忆整理器/);
  assert.match(prompt.user, /今天/);

  // P2：新事实替代旧事实；旧条目保留但不进入默认列表/检索。
  const oldFact = core.memory.add({ text: '项目使用 Vue 做前端', tier: 'active', importance: 3 });
  const replaced = core.memory.supersede(oldFact.id, { text: '项目前端已改为 React', importance: 4 });
  assert.equal(replaced.old.status, 'superseded');
  assert.equal(replaced.old.supersededBy, replaced.replacement.id);
  assert.deepEqual(replaced.replacement.supersedes, [oldFact.id]);
  assert.ok(!core.memory.list().some((row) => row.id === oldFact.id));
  assert.ok(core.memory.health().superseded >= 1);

  // 旧条目衰减后不应影响 core 注入。
  const old = core.memory.add({
    text: '很久以前的低优先级片段',
    tier: 'active',
    importance: 1,
    createdAt: Date.now() - 400 * 86400000,
    updatedAt: Date.now() - 400 * 86400000,
  });
  const decayed = await core.memory.maintain({ day: '2026-11-15' });
  assert.ok(decayed.decayed.changed >= 1);
  assert.doesNotMatch(core.memory.blocks().active, /很久以前的低优先级片段/);
  assert.ok(old.id);

  // 布局兼容：新布局 <角色>/memory 优先；只有旧目录时仍能找到。
  {
    const base = path.join(temp, 'characters', 'layout-check');
    fs.mkdirSync(path.join(base, 'memory-v2', 'space'), { recursive: true });
    fs.writeFileSync(path.join(base, 'memory-v2', 'space', 'entries.jsonl'), '', 'utf8');
    const store = createMemoryStore({ paths: core.paths });
    assert.equal(store.describe('layout-check').spaceDir, path.join(base, 'memory-v2', 'space'));
    fs.mkdirSync(path.join(base, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(base, 'memory', 'entries.jsonl'), '', 'utf8');
    assert.equal(store.describe('layout-check').spaceDir, path.join(base, 'memory'));
  }

  console.log('✅ 记忆升级测试通过');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
