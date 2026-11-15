/**
 * DSH 一次性补全适配器：为夜间记忆整理开一个临时会话，等它输出 JSON 后归档。
 *
 * 只由 Host 注入；Core 不认识 DSH。失败时抛错，由 session 层记录并保留确定性维护结果。
 */
import { randomUUID } from 'node:crypto';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (!isObject(part)) return '';
    return String(part.text ?? part.content ?? '');
  }).filter(Boolean).join('\n');
}

function assistantText(record) {
  const event = isObject(record?.event) ? record.event : record;
  if (!isObject(event) || String(event.type || '') !== 'assistant/message') return '';
  const data = isObject(event.data) ? event.data : {};
  const message = isObject(data.message) ? data.message : data;
  return contentText(message.content ?? data.content ?? message.text ?? data.text).trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createDshCompletion({
  sessionController,
  workspaceRegistry = null,
  preset = 'onefish-core',
  cwd = '',
  logger = () => {},
  timeoutMs = 180_000,
  pollMs = 1_500,
} = {}) {
  if (!sessionController) return null;

  async function waitForAnswer(sessionId) {
    const deadline = Date.now() + Math.max(10_000, Number(timeoutMs) || 180_000);
    let last = '';
    while (Date.now() < deadline) {
      try {
        const page = await sessionController.events({
          address: { kind: 'session', sessionId },
          maxMessages: 200,
        }, AbortSignal.timeout(30_000));
        for (const record of asArray(page?.records)) {
          const text = assistantText(record);
          if (text) last = text;
        }
        if (last) return last;
      } catch (error) {
        logger(`记忆整理会话读取失败：${error?.message ?? error}`);
      }
      await sleep(Math.max(250, Number(pollMs) || 1_500));
    }
    throw new Error(`记忆整理会话超时：${sessionId}`);
  }

  async function complete({ system = '', user = '' } = {}) {
    let workspaceId = '';
    let workspaceEntity = null;
    if (workspaceRegistry) {
      try {
        const path = String(cwd || '').trim() || undefined;
        workspaceEntity = path && typeof workspaceRegistry.resolveByPath === 'function'
          ? (await workspaceRegistry.resolveByPath(path))
          : null;
        if (!workspaceEntity && typeof workspaceRegistry.create === 'function') {
          workspaceEntity = await workspaceRegistry.create(path, 'onefish-memory');
        }
        workspaceId = String(workspaceEntity?.id || '');
      } catch (error) {
        logger(`记忆整理 workspace 准备失败：${error?.message ?? error}`);
      }
    }

    const created = await sessionController.create({
      agentPreset: preset,
      ...(workspaceId ? { workspaceId } : {}),
      ...(!workspaceId && cwd ? { cwd } : {}),
    });
    const sessionId = String(created?.sessionId || '').trim();
    if (!sessionId) throw new Error('记忆整理会话创建失败');
    try {
      if (workspaceEntity && typeof workspaceEntity.attachSession === 'function'
        && !(Array.isArray(workspaceEntity.sessionIds) && workspaceEntity.sessionIds.includes(sessionId))) {
        try { await workspaceEntity.attachSession(sessionId); } catch (error) {
          logger(`记忆整理会话 attach 失败：${error?.message ?? error}`);
        }
      }
      if (typeof sessionController.rename === 'function') {
        try { await sessionController.rename({ sessionId, title: `memory-consolidate-${new Date().toISOString().slice(0, 10)}` }); } catch {}
      }
      await sessionController.prompt({
        sessionId,
        requestId: randomUUID(),
        mode: 'queue',
        content: [{ type: 'text', text: `${system}\n\n${user}` }],
      }, AbortSignal.timeout(Math.max(10_000, Number(timeoutMs) || 180_000)));
      return await waitForAnswer(sessionId);
    } finally {
      try {
        if (workspaceRegistry && typeof workspaceRegistry.archiveSession === 'function') {
          await workspaceRegistry.archiveSession(sessionId, { stopActivity: true });
        } else if (typeof sessionController.closeSession === 'function') {
          await sessionController.closeSession({ sessionId });
        } else if (typeof sessionController.deleteSession === 'function') {
          await sessionController.deleteSession({ sessionId });
        }
      } catch (error) {
        logger(`记忆整理会话清理失败：${error?.message ?? error}`);
      }
    }
  }

  return { complete };
}
