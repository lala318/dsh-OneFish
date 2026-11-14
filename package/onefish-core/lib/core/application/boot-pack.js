/**
 * 每日开机包：新日会话的显式上下文。
 *
 * 只拼文本，不写会话；由宿主通过 DSH developer/message 注入到日会话。
 * 内容优先级：核心记忆 → 人格卡 → 主动记忆 → 昨日摘要 → 近期档案 → 使用说明。
 */
import { shiftDay } from '../domain/day.js';
import { DEFAULT_CONFIG } from '../domain/config.js';

function truncate(text, max) {
  const value = String(text || '').trim();
  if (!value || value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 12))}\n…（已截断）`;
}

export function createBootPackService({ persona, memory, archive, config = DEFAULT_CONFIG, now = () => Date.now() } = {}) {
  const options = { ...DEFAULT_CONFIG, ...config };

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
    const digest = archive?.readDigest?.(yesterday);
    if (digest) {
      blocks.push(`【昨天 ${yesterday}】\n${truncate(digest, options.digestMaxChars)}`);
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
