#!/usr/bin/env node
/**
 * 记忆升级回归：遗忘曲线、向量检索、夜间维护。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCore } from '../lib/core/index.js';

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

  const hits = core.memory.search('记忆向量', { k: 5 });
  assert.ok(hits.some((hit) => hit.id === second.id));

  const block = core.memory.blocks();
  assert.match(block.active, /主人喜欢先给结论/);
  assert.match(block.core, /我是 OneFish/);

  const maintained = core.memory.maintain({ day: '2026-11-15' });
  assert.equal(maintained.ok, true);
  assert.ok(maintained.indexed.total >= 3);
  assert.ok(fs.existsSync(core.paths.home + '/memory-v2/space/vectors/index.jsonl'));

  const index = path.join(core.memory.resolveDirs().spaceDir, 'vectors', 'index.jsonl');
  assert.ok(fs.existsSync(index));
  assert.ok(core.memory.list().every((row) => typeof row.retention === 'number'));

  // 旧条目衰减后不应影响 core 注入。
  const old = core.memory.add({
    text: '很久以前的低优先级片段',
    tier: 'active',
    importance: 1,
    createdAt: Date.now() - 400 * 86400000,
    updatedAt: Date.now() - 400 * 86400000,
  });
  const decayed = core.memory.maintain({ day: '2026-11-15' });
  assert.ok(decayed.decayed.changed >= 1);
  assert.doesNotMatch(core.memory.blocks().active, /很久以前的低优先级片段/);
  assert.ok(old.id);

  console.log('✅ 记忆升级测试通过');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
