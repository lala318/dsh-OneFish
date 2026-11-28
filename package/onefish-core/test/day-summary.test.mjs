#!/usr/bin/env node
/**
 * 日摘要压缩：注入提示不进模型、长日分块、合并后不超预算，无内容不调用模型。
 */
import assert from 'node:assert/strict';
import { createDaySummarizer, chunkLines } from '../lib/core/application/day-summary.js';

// 1) 无内容：不调用模型
{
  const calls = [];
  const s = createDaySummarizer({ complete: async (p) => { calls.push(p); return '- x'; }, maxChars: 300 });
  const out = await s.summarize({ day: '2026-11-20', messages: [{ role: 'user', text: '【空闲】现在是 22:00' }] });
  assert.equal(out, '');
  assert.equal(calls.length, 0, '只有注入提示时不该调用模型');
}

// 2) 注入提示不进 prompt，正文进 prompt
{
  const prompts = [];
  const s = createDaySummarizer({ complete: async (p) => { prompts.push(p); return '- 主人决定周五前提交召回修复'; }, maxChars: 300 });
  const out = await s.summarize({
    day: '2026-11-20',
    messages: [
      { role: 'user', text: '【空闲】现在是 2026-11-20 22:00，距离上次说话已经 1 小时' },
      { role: 'user', text: '<system-reminder>The following information describes</system-reminder>' },
      { role: 'user', text: '我决定周五前把召回门槛修完提交' },
      { role: 'assistant', text: '记下了，周五我会问你进度。' },
    ],
  });
  assert.equal(out, '- 主人决定周五前提交召回修复');
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /我决定周五前把召回门槛修完提交/);
  assert.match(prompts[0], /我：记下了/);
  assert.doesNotMatch(prompts[0], /助手/);
  assert.doesNotMatch(prompts[0], /空闲|system-reminder/);
}

// 3) 长日：分块压缩，然后合并；输出不超过 maxChars
{
  const prompts = [];
  const s = createDaySummarizer({
    complete: async (p) => {
      prompts.push(p);
      // 每次回一段 200 字的要点，模拟模型输出
      return `- ${'要点'.repeat(100)}`;
    },
    maxChars: 500,
    chunkChars: 1500,
  });
  const messages = [];
  for (let i = 0; i < 60; i += 1) messages.push({ role: 'user', text: `第 ${i} 句：${'内容'.repeat(20)}` });
  const out = await s.summarize({ day: '2026-11-21', messages });
  assert.ok(prompts.length > 2, `应分多块压缩并合并，实际调用 ${prompts.length} 次`);
  assert.ok(out.length <= 500, `输出应不超过 500 字，实际 ${out.length}`);
  assert.ok(prompts.some((p) => /分段要点开始/.test(p)), '应有合并阶段');
}

// 4) chunkLines：超长单行独占一块，不拆
{
  const chunks = chunkLines(['a'.repeat(50), 'b', 'c'], 20);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, 50);
  assert.equal(chunks[1], 'b\nc');
}

console.log('✅ 日摘要压缩测试通过');
