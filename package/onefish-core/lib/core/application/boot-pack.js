/**
 * 每日开机包：新日会话的显式上下文。
 *
 * 只拼文本，不写会话；由宿主通过 DSH developer/message 注入到日会话。
 * 内容优先级：核心记忆 → 人格卡 → 主动记忆 → 昨日摘要 → 近期档案 → 使用说明。
 */
import { shiftDay } from '../domain/day.js';
import { DEFAULT_CONFIG } from '../domain/config.js';
import { usableMessages } from '../domain/day-messages.js';

function truncate(text, max) {
  const value = String(text || '').trim();
  if (!value || value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 12))}\n…（已截断）`;
}

// 带“要紧信号”的话：决定、计划、约定、待办、截止、卡住之类，优先留下。
const SALIENT = /决定|计划|打算|记得|答应|约定|承诺|下次|明天|截止|提交|完成|没做|做完|卡住|问题|目标|任务|必须|以后|不要|别再|考|bug|修/i;
// 纯应付的短回复，没有信息量。
const FILLER = /^(嗯+|哦+|噢+|好+的?|行+|对|是的?|收到|谢谢|哈+|哈哈+|hi|ok|1|。+|\?+|？+)$/i;

function oneLine(text, max = 140) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * 从一天的全量消息里挑出“重点”，不是按时间头部截断。
 * 规则：丢掉填充语和过短消息；用户话优先；带要紧信号的加分；
 * 去重后按得分取到预算为止，再按原时间顺序排列。
 * messages: [{ role, text }]，返回可直接拼进开机包的文本（没有可用内容时返回空串）。
 */
export function distillDay(messages = [], { maxChars = 1200, skipPrefixes = [] } = {}) {
  const all = usableMessages(messages, { skipPrefixes });
  if (!all.length) return '';
  const userCount = all.filter((m) => m.role === 'user').length;
  const header = `（昨天共 ${all.length} 条消息，其中用户 ${userCount} 条；以下是挑出的重点，不是全文，细节用 mcp__onefish-core__memory_archive_search 查）`;
  const budget = Math.max(0, maxChars - header.length - 2);

  const scored = [];
  const seen = new Set();
  all.forEach((m, index) => {
    const text = oneLine(m.text, 400);
    if (text.length < 6 || FILLER.test(text)) return;
    const isUser = m.role === 'user';
    const salient = SALIENT.test(text);
    // 我（助手）的话只留带要紧信号的（多半是我答应了什么）；主人的话普遍保留。
    if (!isUser && !salient) return;
    const key = text.slice(0, 24);
    if (seen.has(key)) return;
    seen.add(key);
    const score = Math.min(text.length, 160) / 40 + (isUser ? 1 : 0) + (salient ? 3 : 0);
    scored.push({ index, score, role: isUser ? '用户' : '我', text: oneLine(text) });
  });
  if (!scored.length) return '';

  const picked = [];
  let used = 0;
  for (const item of [...scored].sort((a, b) => b.score - a.score || a.index - b.index)) {
    const line = `- [${item.role}] ${item.text}`;
    if (used + line.length + 1 > budget) continue;
    picked.push({ ...item, line });
    used += line.length + 1;
  }
  if (!picked.length) return '';
  picked.sort((a, b) => a.index - b.index);
  return [header, ...picked.map((item) => item.line)].join('\n');
}

export function createBootPackService({ persona, memory, archive, config = DEFAULT_CONFIG, now = () => Date.now() } = {}) {
  const options = { ...DEFAULT_CONFIG, ...config };

  /** 昨天的内容：优先从全量档案里提炼重点；没有档案时才退回日摘要原文。 */
  function yesterdayBody(yesterday) {
    let summary = null;
    try {
      summary = typeof archive?.readSummary === 'function' ? archive.readSummary(yesterday) : null;
    } catch {
      summary = null;
    }
    if (summary?.text) return truncate(summary.text, options.digestMaxChars);
    let messages = [];
    try {
      messages = typeof archive?.readDay === 'function' ? archive.readDay(yesterday) : [];
    } catch {
      messages = [];
    }
    const distilled = distillDay(messages, {
      maxChars: options.digestMaxChars,
      skipPrefixes: options.recall?.skipPrefixes || [],
    });
    if (distilled) return distilled;
    const digest = archive?.readDigest?.(yesterday);
    return digest ? truncate(digest, options.digestMaxChars) : '';
  }

  function build({ day, workspace = null } = {}) {
    const currentDay = String(day || '').trim();
    if (!currentDay) throw new Error('boot pack requires day');
    const blocks = [];
    blocks.push(`【OneFish 开机包】${currentDay}`);
    if (workspace?.workspaceTitle) blocks.push(`【工作区】${workspace.workspaceTitle}`);
    blocks.push(`【时间】${new Date(now()).toLocaleString()}`);

    const memoryBlocks = memory?.blocks?.() || {};
    if (memoryBlocks.core) blocks.push(memoryBlocks.core);

    const card = persona?.get?.();
    if (card?.text) {
      blocks.push(`【人格卡】${card.name ? `（${card.name}）` : ''}\n${truncate(card.text, options.personaMaxChars)}`);
    }

    if (memoryBlocks.active) blocks.push(memoryBlocks.active);

    const yesterday = shiftDay(currentDay, -1);
    const yesterdayText = yesterdayBody(yesterday);
    if (yesterdayText) {
      blocks.push(`【昨天 ${yesterday}】\n${yesterdayText}`);
    }

    const recent = (archive?.listDays?.() || [])
      .filter((item) => item < currentDay)
      .slice(0, 7);
    if (recent.length) blocks.push(`【近期档案】${recent.join('、')}`);

    blocks.push([
      '【使用方式】',
      '- 消息可能来自 DSH 原生对话窗口或频道组件；以消息里的【频道】和组件提供的上下文为准。',
      '- 来自 DSH 窗口时，文本直接显示；来自频道时，使用当前可用的频道发送工具，不要把回复只写在 DSH 窗口。',
      '- 人格卡、核心记忆和主动记忆已经在本开机包里；不需要每轮重复调用 persona_get。',
      '- 需要更多记忆时用 mcp__onefish-core__memory_search；全量历史用 mcp__onefish-core__memory_archive_search。',
      '- 写/改/删记忆用 mcp__onefish-core__memory_add / memory_update / memory_delete；列表用 memory_list。',
      '- 不要声称完成了没有执行的操作；涉及本地文件/命令时，以真实工具结果为准。',
    ].join('\n'));

    blocks.push('【此刻】今天第一次打开日会话。');

    let out = blocks.filter(Boolean).join('\n\n');
    if (out.length > options.bootMaxChars) out = truncate(out, options.bootMaxChars);
    return out;
  }

  return { build };
}
