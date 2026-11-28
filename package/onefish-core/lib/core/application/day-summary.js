/**
 * 日摘要压缩：用模型把一天的原文压成要点，类似上下文压缩——没用的丢掉，要紧的保留。
 *
 * 流程：原文按块切（每块约 chunkChars 字）→ 每块压成要点 → 要点多了再分组合并，
 * 直到不超过 maxChars。只在日终整理时跑一次，结果落在 archive/digests/<day>.summary.md，
 * 开机包直接读它。
 */
import { usableMessages } from '../domain/day-messages.js';

const LINE_MAX = 300;

function oneLine(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function transcriptLine(message) {
  const who = message.role === 'user' ? '主人' : '我';
  return `${who}：${oneLine(message.text, LINE_MAX)}`;
}

/** 按字数把若干行切成块；单行超长也独占一块，不拆。 */
export function chunkLines(lines = [], maxChars = 6000) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const line of lines) {
    const text = String(line || '');
    if (current.length && size + text.length + 1 > maxChars) {
      chunks.push(current.join('\n'));
      current = [];
      size = 0;
    }
    current.push(text);
    size += text.length + 1;
  }
  if (current.length) chunks.push(current.join('\n'));
  return chunks;
}

export function compressPrompt({ day, transcript, maxChars }) {
  return [
    `下面是 ${day} 这一天我（OneFish）和主人的一段对话原文。请用我自己的口吻，把它压缩成当日自述要点，供我第二天开机时读。`,
    '',
    '要保留：',
    '- 主人做出的决定、计划、约定、待办、截止时间；',
    '- 未解决的问题、卡住的地方、主人明确说过的偏好或边界；',
    '- 主人纠正过我的地方；',
    '- 我答应过要做的事。',
    '',
    '要丢掉：寒暄、客套、重复的话、被推翻的中间想法、工具输出细节。',
    '',
    `输出要求：中文；用第一人称“我”指代自己，用“主人”指代对方；不超过 ${maxChars} 字；每条以 "- " 开头；只写原文里有的内容，不要推测、不要加解释。`,
    '',
    '--- 原文开始 ---',
    transcript,
    '--- 原文结束 ---',
  ].join('\n');
}

export function mergePrompt({ day, parts, maxChars }) {
  return [
    `下面是我（OneFish）${day} 这一天按时间顺序分段压缩出来的自述要点。请合并去重，压成一份完整的当日自述。`,
    '',
    '合并规则：同一件事只留一条；被后面推翻的旧结论要以后面的为准；保持时间顺序。',
    '',
    `输出要求：中文；保持第一人称“我”和“主人”的写法；不超过 ${maxChars} 字；每条以 "- " 开头；只保留输入里有的内容，不要推测、不要加解释。`,
    '',
    '--- 分段要点开始 ---',
    parts.join('\n'),
    '--- 分段要点结束 ---',
  ].join('\n');
}

function cleanAnswer(text) {
  return String(text || '')
    .replace(/^```[a-zA-Z]*\s*/m, '')
    .replace(/```\s*$/m, '')
    .trim();
}

export function createDaySummarizer({
  complete,
  maxChars = 1200,
  chunkChars = 6000,
  maxMergeRounds = 4,
  logger = () => {},
} = {}) {
  async function summarize({ day, messages = [], skipPrefixes = [] } = {}) {
    if (typeof complete !== 'function') throw new Error('daySummarizer requires complete(prompt)');
    const usable = usableMessages(messages, { skipPrefixes });
    if (!usable.length) return '';

    const chunks = chunkLines(usable.map(transcriptLine), chunkChars);
    const perChunk = Math.min(600, maxChars);
    let parts = [];
    for (const chunk of chunks) {
      const answer = await complete(compressPrompt({ day, transcript: chunk, maxChars: perChunk }));
      const cleaned = cleanAnswer(answer);
      if (cleaned) parts.push(cleaned);
    }
    if (!parts.length) return '';

    let round = 0;
    while (parts.length > 1 || parts[0].length > maxChars) {
      round += 1;
      if (round > maxMergeRounds) break;
      const groups = chunkLines(parts, chunkChars);
      const next = [];
      for (const group of groups) {
        const answer = await complete(mergePrompt({ day, parts: group.split('\n'), maxChars }));
        const cleaned = cleanAnswer(answer);
        if (cleaned) next.push(cleaned);
      }
      if (!next.length) break;
      parts = next;
    }
    logger(`日摘要压缩：${day}，${usable.length} 条消息 → ${chunks.length} 块 → ${parts.join('\n').length} 字`);

    const text = parts.join('\n');
    return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
  }

  return { summarize };
}
