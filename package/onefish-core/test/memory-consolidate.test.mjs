#!/usr/bin/env node
/**
 * 记忆整理器 P1 回归：
 *   - 提示词包含逻辑日、摘要、三层记忆与 JSON 约束；
 *   - 解析围栏/夹带说明的 JSON；
 *   - 拒绝 core 超限、低置信、缺失 id、重复正文、敏感信息；
 *   - 落库 add / update / merge / forget / supersede / pin / unpin；
 *   - sourceDays 自动补当天。
 */
import assert from 'node:assert/strict';
import {
  buildConsolidatePrompt,
  parseConsolidateOutput,
  validateConsolidateOps,
  applyConsolidateOps,
  CONSOLIDATE_MAX_OPS,
  CONSOLIDATE_MAX_CORE_OPS,
} from '../lib/core/application/memory-consolidate.js';

const DAY = '2026-11-15';

/**
 * 够用的内存版 memory-space：
 * 只实现整理器依赖的 get/list/add/update/softDelete/audit。
 */
function createFakeSpace(seed = []) {
  let nextId = 0;
  const audits = [];
  const rows = [];

  function makeRow(input = {}, forcedId = '') {
    const id = forcedId || input.id || `mem_new_${nextId += 1}`;
    return {
      id,
      space: input.space || 'master',
      kind: input.kind || 'fact',
      tier: input.tier || 'active',
      status: input.status || 'active',
      text: String(input.text ?? '').trim(),
      tags: Array.isArray(input.tags) ? [...input.tags] : [],
      importance: Number(input.importance) || (input.tier === 'core' ? 5 : 3),
      sourceDays: Array.isArray(input.sourceDays) ? [...input.sourceDays] : [],
      sourceEventIds: Array.isArray(input.sourceEventIds) ? [...input.sourceEventIds] : [],
      confidence: Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : 0.5,
      by: input.by || 'agent',
      createdAt: input.createdAt || 1,
      updatedAt: input.updatedAt || 1,
      deletedAt: input.deletedAt || null,
      meta: input.meta && typeof input.meta === 'object' ? { ...input.meta } : {},
    };
  }

  for (const item of seed) rows.push(makeRow(item, item.id));

  function copy(row) {
    return {
      ...row,
      tags: [...row.tags],
      sourceDays: [...row.sourceDays],
      sourceEventIds: [...row.sourceEventIds],
      meta: { ...row.meta },
    };
  }

  function get(id) {
    return rows.find((row) => row.id === String(id)) || null;
  }

  function list({ tier = '', includeDeleted = false, limit = 0 } = {}) {
    let out = rows.filter((row) => includeDeleted || !row.deletedAt);
    if (tier) out = out.filter((row) => row.tier === tier);
    if (limit > 0) out = out.slice(0, limit);
    return out.map(copy);
  }

  function add(input) {
    const row = makeRow(input);
    if (rows.some((existing) => existing.id === row.id)) throw new Error(`duplicate id: ${row.id}`);
    rows.push(row);
    return copy(row);
  }

  function update(id, patch = {}) {
    const index = rows.findIndex((row) => row.id === String(id));
    if (index < 0) return null;
    const previous = rows[index];
    const row = makeRow({
      ...previous,
      ...patch,
      id: previous.id,
      createdAt: previous.createdAt,
      updatedAt: Number(patch.updatedAt) || Date.now(),
      meta: patch.meta !== undefined ? patch.meta : previous.meta,
    }, previous.id);
    rows[index] = row;
    return copy(row);
  }

  function softDelete(id, by = 'owner') {
    return update(id, { deletedAt: Date.now(), by });
  }

  function audit(day, record) {
    audits.push({ day, ...record });
  }

  return { rows, audits, get, list, add, update, softDelete, audit };
}

function baseSpace() {
  return createFakeSpace([
    {
      id: 'core_identity', tier: 'core', kind: 'fact', text: '身份：我是 OneFish',
      importance: 5, confidence: 0.95, tags: ['identity'], sourceDays: ['2026-11-01'],
    },
    {
      id: 'core_boundary', tier: 'core', kind: 'commitment', text: '边界：不替主人做不可逆决定',
      importance: 5, confidence: 0.95, tags: ['boundary'], sourceDays: ['2026-11-01'],
    },
    {
      id: 'act_style', tier: 'active', kind: 'preference', text: '主人喜欢先给结论再补理由',
      importance: 4, confidence: 0.85, tags: ['preference'], sourceDays: ['2026-11-10'],
    },
    {
      id: 'act_project', tier: 'active', kind: 'open_loop', text: 'OneFish 正在做记忆整理模块',
      importance: 3, confidence: 0.8, tags: ['project'], sourceDays: ['2026-11-12'],
    },
    {
      id: 'kb_slack', tier: 'knowledge', kind: 'slang', text: '「摸鱼」含义：上班时间偷懒',
      importance: 2, confidence: 0.7, tags: ['slang'], sourceDays: ['2026-11-05'],
    },
  ]);
}

function addOp(text, extra = {}) {
  return {
    op: 'add',
    tier: 'active',
    kind: 'fact',
    text,
    confidence: 0.8,
    sourceDays: ['2026-11-14'],
    ...extra,
  };
}

function check(ops, space = baseSpace(), day = DAY) {
  return validateConsolidateOps(ops, { space, day });
}

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✅ ${name}`);
  } catch (error) {
    console.error(`❌ ${name}`);
    throw error;
  }
}

test('提示词包含逻辑日、摘要、三层记忆与 op 约束', () => {
  const { system, user } = buildConsolidatePrompt({
    day: DAY,
    digest: '# OneFish 2026-11-15\n- 讨论了记忆整理',
    events: [{ seq: 7, role: 'user', text: '把记忆整理成 ops' }],
    core: [{ id: 'core_identity', text: '身份：我是 OneFish', tags: ['identity'] }],
    active: [{ id: 'act_style', text: '主人喜欢先给结论' }],
    knowledge: [{ id: 'kb_slack', text: '「摸鱼」含义：上班时间偷懒' }],
    maxOps: 12,
  });

  assert.match(system, /core/);
  assert.match(system, /active/);
  assert.match(system, /knowledge/);
  assert.match(system, /supersede/);
  assert.match(system, /sourceDays/);
  assert.match(system, /不要编造/);
  assert.match(system, /密码|令牌/);
  assert.match(system, /ownerRequested/);
  assert.match(system, /只输出一个 JSON 对象/);

  assert.match(user, new RegExp(DAY));
  assert.match(user, /讨论了记忆整理/);
  assert.match(user, /把记忆整理成 ops/);
  assert.match(user, /\[core_identity\] 身份：我是 OneFish/);
  assert.match(user, /\[act_style\] 主人喜欢先给结论/);
  assert.match(user, /\[kb_slack\]/);
  assert.match(user, /最多 12 条/);
});

test('解析围栏 JSON、夹带说明的 JSON，并给出明确错误', () => {
  assert.deepEqual(
    parseConsolidateOutput('说明\n```json\n{"ops":[{"op":"add","text":"新事实"}]}\n```\n结束'),
    [{ op: 'add', text: '新事实' }],
  );
  assert.deepEqual(parseConsolidateOutput('{"ops":[]}'), []);
  assert.deepEqual(
    parseConsolidateOutput('前缀 {"ops":[{"op":"update","id":"act_style"}]} 后缀'),
    [{ op: 'update', id: 'act_style' }],
  );
  assert.deepEqual(parseConsolidateOutput('说明 {不是 JSON}，结果：{"ops":[]}'), []);

  assert.throws(() => parseConsolidateOutput(''), /空/);
  assert.throws(() => parseConsolidateOutput('没有 JSON'), /JSON 对象/);
  assert.throws(() => parseConsolidateOutput('{"ops":[}'), /解析失败/);
  assert.throws(() => parseConsolidateOutput('{"foo":1}'), /ops 数组/);
});

test('core 每天最多 2 条', () => {
  const result = check([
    addOp('core 事实一', { tier: 'core', importance: 5, confidence: 0.9 }),
    addOp('core 事实二', { tier: 'core', importance: 5, confidence: 0.9 }),
    addOp('core 事实三', { tier: 'core', importance: 5, confidence: 0.9 }),
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.ops.length, CONSOLIDATE_MAX_CORE_OPS);
  assert.match(result.errors.join('\n'), /core 超过每日 2 条上限/);
});

test('拒绝低置信、越界置信与 core 低 importance', () => {
  let result = check([addOp('低置信 active', { confidence: 0.2 })]);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /confidence 太低/);

  result = check([addOp('低置信 core', { tier: 'core', importance: 5, confidence: 0.5 })]);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /core 的 confidence 必须/);

  result = check([addOp('core 重要度不足', { tier: 'core', importance: 4, confidence: 0.9 })]);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /core 的 importance 必须是 5/);

  result = check([addOp('置信度越界', { confidence: 1.2 })]);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /0~1/);
});

test('拒绝缺失 id、重复处理同一 id、非法 merge', () => {
  let result = check([{ op: 'update', id: 'missing', text: '新内容', confidence: 0.8 }]);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /id 不存在/);

  result = check([{ op: 'forget', id: 'missing', confidence: 0.8 }]);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /id 不存在/);

  result = check([{ op: 'merge', ids: ['act_style'], text: '合并后的内容', confidence: 0.8 }]);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /至少需要 2 个/);

  result = check([{ op: 'merge', ids: ['act_style', 'missing'], text: '合并后的内容', confidence: 0.8 }]);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /id 不存在/);

  result = check([{ op: 'supersede', id: 'missing', text: '新的替代事实', confidence: 0.9 }]);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /id 不存在/);

  result = check([
    { op: 'update', id: 'act_style', text: '更新后的偏好', confidence: 0.8 },
    { op: 'forget', id: 'act_style', confidence: 0.9 },
  ]);
  assert.equal(result.ops.length, 1);
  assert.match(result.errors.join('\n'), /同一个 id/);
});

test('拒绝与已有正文重复（忽略标点），但允许更新自己', () => {
  const space = baseSpace();
  let result = check([addOp('主人喜欢先给结论再补理由。')], space);
  assert.equal(result.ops.length, 0);
  assert.match(result.errors.join('\n'), /重复条目/);

  result = check([addOp('全新的独立事实'), addOp('全新的独立事实！')], space);
  assert.equal(result.ops.length, 1);
  assert.match(result.errors.join('\n'), /同一批 ops 里重复/);

  result = check([{
    op: 'update',
    id: 'act_style',
    text: '主人喜欢先给结论再补理由',
    confidence: 0.8,
  }], space);
  assert.equal(result.ok, true);
  assert.equal(result.ops.length, 1);
});

test('拒绝密码、令牌与密钥形态的正文', () => {
  for (const text of [
    '接口令牌 token="abcdefgh12345678"',
    'api_key: sk-abcdefghijklmnopqrstuvwx',
    '新密码：hunter2',
    'Authorization: Bearer abcdefgh12345678',
  ]) {
    const result = check([addOp(text)]);
    assert.equal(result.ok, false, `应拒绝：${text}`);
    assert.match(result.errors.join('\n'), /密码|令牌|密钥/);
  }
});

test('sourceDays 自动补当天，并遵守每日 24 条上限', () => {
  const space = baseSpace();
  const result = check([addOp('主人偏好：咖啡不加糖', {
    sourceDays: ['2026-11-14', '2026-11-13'],
  })], space);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ops[0].sourceDays, [DAY, '2026-11-14', '2026-11-13']);

  const tooMany = check(
    Array.from({ length: 25 }, (_, index) => addOp(`独立事实编号 ${index}`)),
    space,
  );
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.ops.length, CONSOLIDATE_MAX_OPS);
  assert.match(tooMany.errors.join('\n'), /24 条 ops 上限/);
});

test('落库 add 与 update，并保留来源日', () => {
  const space = baseSpace();
  const addValidation = check([addOp('主人偏好：咖啡不加糖', {
    sourceDays: ['2026-11-14'],
  })], space);
  let result = applyConsolidateOps(space, addValidation.ops, { day: DAY });
  assert.deepEqual(result.skipped, []);
  assert.equal(result.applied[0].op, 'add');

  const added = space.list().find((row) => row.text === '主人偏好：咖啡不加糖');
  assert.ok(added);
  assert.deepEqual(added.sourceDays, [DAY, '2026-11-14']);
  assert.equal(added.by, 'consolidator');
  assert.equal(added.meta.consolidatedDay, DAY);
  assert.equal(added.tier, 'active');
  assert.ok(space.audits.some((record) => record.op === 'add'));

  const updateValidation = check([{
    op: 'update',
    id: 'act_style',
    text: '主人偏好：先给结论，再解释原因',
    tier: 'active',
    kind: 'preference',
    importance: 4,
    confidence: 0.9,
  }], space);
  result = applyConsolidateOps(space, updateValidation.ops, { day: DAY });
  assert.deepEqual(result.skipped, []);
  assert.equal(result.applied[0].op, 'update');

  const updated = space.get('act_style');
  assert.equal(updated.text, '主人偏好：先给结论，再解释原因');
  assert.ok(updated.sourceDays.includes('2026-11-10'));
  assert.ok(updated.sourceDays.includes(DAY));
  assert.equal(updated.meta.consolidatedDay, DAY);
  assert.ok(space.audits.some((record) => record.op === 'update'));
});

test('落库 merge：更新目标、软删其余并合并标签/来源', () => {
  const space = baseSpace();
  const validation = check([{
    op: 'merge',
    ids: ['act_style', 'act_project'],
    text: '主人偏好先给结论；OneFish 正在做记忆整理模块',
    tier: 'active',
    kind: 'preference',
    importance: 4,
    confidence: 0.9,
  }], space);
  assert.equal(validation.ok, true);

  const result = applyConsolidateOps(space, validation.ops, { day: DAY });
  assert.deepEqual(result.skipped, []);
  assert.equal(result.applied[0].op, 'merge');
  assert.deepEqual(result.applied[0].merged, ['act_project']);

  const target = space.get('act_style');
  assert.equal(target.text, '主人偏好先给结论；OneFish 正在做记忆整理模块');
  assert.ok(target.tags.includes('preference'));
  assert.ok(target.tags.includes('project'));
  assert.ok(target.sourceDays.includes('2026-11-10'));
  assert.ok(target.sourceDays.includes('2026-11-12'));
  assert.ok(target.sourceDays.includes(DAY));
  assert.deepEqual(target.meta.mergedFrom, ['act_project']);
  assert.ok(space.get('act_project').deletedAt);
  assert.equal(space.list().some((row) => row.id === 'act_project'), false);
});

test('落库 forget 与 supersede（旧正文留在 meta）', () => {
  let space = baseSpace();
  const forgetValidation = check([{
    op: 'forget',
    id: 'act_project',
    confidence: 0.9,
    reason: '项目已归档',
  }], space);
  assert.equal(forgetValidation.ok, true);

  let result = applyConsolidateOps(space, forgetValidation.ops, { day: DAY });
  assert.deepEqual(result.skipped, []);
  assert.equal(result.applied[0].op, 'forget');
  assert.ok(space.get('act_project').deletedAt);
  assert.ok(space.audits.some((record) => record.op === 'forget'));

  space = baseSpace();
  const previousText = space.get('act_project').text;
  const supersedeValidation = check([{
    op: 'supersede',
    id: 'act_project',
    text: 'OneFish 记忆整理模块已接入日终流程',
    tier: 'active',
    importance: 4,
    confidence: 0.9,
    reason: '旧事实被新进展替代',
  }], space);
  assert.equal(supersedeValidation.ok, true);

  result = applyConsolidateOps(space, supersedeValidation.ops, { day: DAY });
  assert.deepEqual(result.skipped, []);
  assert.equal(result.applied[0].op, 'supersede');

  const superseded = space.get('act_project');
  assert.equal(superseded.id, 'act_project');
  assert.equal(superseded.text, 'OneFish 记忆整理模块已接入日终流程');
  assert.equal(superseded.meta.supersededText, previousText);
  assert.equal(superseded.meta.supersededDay, DAY);
  assert.ok(superseded.meta.supersededAt);
  assert.ok(superseded.sourceDays.includes('2026-11-12'));
  assert.ok(superseded.sourceDays.includes(DAY));
  assert.ok(space.audits.some((record) => record.op === 'supersede'));
});

test('落库 pin / unpin，并保护 core 不被自动 forget', () => {
  const space = baseSpace();

  const pinValidation = check([{
    op: 'pin',
    id: 'act_style',
    confidence: 0.9,
    reason: '主人明确要求长期记住',
  }], space);
  assert.equal(pinValidation.ok, true);
  let result = applyConsolidateOps(space, pinValidation.ops, { day: DAY });
  assert.equal(result.applied[0].op, 'pin');
  assert.equal(space.get('act_style').tier, 'core');
  assert.equal(space.get('act_style').importance, 5);

  const unpinValidation = check([{
    op: 'unpin',
    id: 'act_style',
    confidence: 0.8,
  }], space);
  assert.equal(unpinValidation.ok, true);
  result = applyConsolidateOps(space, unpinValidation.ops, { day: DAY });
  assert.equal(result.applied[0].op, 'unpin');
  assert.equal(space.get('act_style').tier, 'active');
  assert.equal(space.get('act_style').importance, 3);

  const blocked = check([{ op: 'forget', id: 'core_identity', confidence: 0.95 }], space);
  assert.equal(blocked.ok, false);
  assert.match(blocked.errors.join('\n'), /ownerRequested/);

  // 即使绕过 validate 直接 apply，也要跳过没有主人授权的 core forget。
  result = applyConsolidateOps(space, [{
    op: 'forget',
    id: 'core_identity',
    confidence: 0.95,
  }], { day: DAY });
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped[0].reason, 'core-requires-owner-request');

  const allowed = check([{
    op: 'forget',
    id: 'core_identity',
    confidence: 0.95,
    ownerRequested: true,
    reason: '主人明确要求忘掉',
  }], space);
  assert.equal(allowed.ok, true);
  result = applyConsolidateOps(space, allowed.ops, { day: DAY });
  assert.deepEqual(result.skipped, []);
  assert.equal(result.applied[0].op, 'forget');
  assert.ok(space.get('core_identity').deletedAt);
});

console.log(`✅ 记忆整理器测试全部通过（${passed} 项）`);
