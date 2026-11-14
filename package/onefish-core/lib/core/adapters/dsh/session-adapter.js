/**
 * DSH 会话适配层。
 *
 * Core 只认这里的抽象；DSH 版本变化时改这一层，不改 day/session/archive 规则。
 */
import { randomUUID } from 'node:crypto';

export function createDshSessionAdapter({
  sessionController,
  workspaceRegistry = null,
  sessions = null,
  logger = () => {},
  historyPageMessages = 200,
  historyMaxPages = 50,
} = {}) {
  if (!sessionController) throw new Error('sessionController is not available');

  let workspaceCache = null;

  async function ensureWorkspace({ path, title } = {}) {
    if (!path || !workspaceRegistry) return null;
    if (workspaceCache && workspaceCache.path === path && workspaceCache.title === title) return workspaceCache;
    let workspace = null;
    if (typeof workspaceRegistry.resolveByPath === 'function') {
      workspace = await workspaceRegistry.resolveByPath(path);
    }
    if (!workspace && typeof workspaceRegistry.create === 'function') {
      workspace = await workspaceRegistry.create(path, title);
    }
    if (!workspace) return null;
    if (title && workspace.title !== title && typeof workspace.setTitle === 'function') {
      await workspace.setTitle(title);
      if (typeof workspaceRegistry.get === 'function') workspace = workspaceRegistry.get(workspace.id) || workspace;
    }
    workspaceCache = {
      workspaceId: String(workspace.id || ''),
      workspaceTitle: String(workspace.title || title || ''),
      workspacePath: String(workspace.path || path || ''),
    };
    logger(`DSH workspace 已就绪：${workspaceCache.workspaceTitle} (${workspaceCache.workspaceId})`);
    return workspaceCache;
  }

  async function createDaily({ preset, title, day, workspaceId, cwd } = {}) {
    const created = await sessionController.create({
      agentPreset: preset,
      ...(workspaceId ? { workspaceId } : {}),
      ...(!workspaceId && cwd ? { cwd } : {}),
    });
    const sessionId = String(created?.sessionId || '').trim();
    if (!sessionId) throw new Error('sessionController.create returned no sessionId');
    if (title && typeof sessionController.rename === 'function') {
      try {
        await sessionController.rename({ sessionId, title });
      } catch (error) {
        logger(`日会话重命名失败 ${sessionId}：${error?.message ?? error}`);
      }
    }
    logger(`DSH 日会话已创建：${day || ''} ${sessionId}${workspaceId ? ` @ ${workspaceId}` : ''}`);
    return { sessionId, preset: String(created?.agentPreset || preset || '') };
  }

  async function history(sessionId) {
    if (typeof sessionController.events !== 'function') throw new Error('sessionController.events is not available');
    const signal = AbortSignal.timeout(60_000);
    const all = [];
    let beforeSeq;
    for (let pageNo = 0; pageNo < historyMaxPages; pageNo += 1) {
      const page = await sessionController.events({
        address: { kind: 'session', sessionId },
        maxMessages: historyPageMessages,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
      }, signal);
      const records = Array.isArray(page?.records) ? page.records : [];
      all.unshift(...records);
      if (!page?.hasMore || records.length === 0) break;
      const firstSeq = Number(records[0]?.event?.seq ?? -1);
      if (!Number.isFinite(firstSeq) || firstSeq < 0 || firstSeq === beforeSeq) break;
      beforeSeq = firstSeq;
    }
    return all;
  }

  async function archive(sessionId, { stopActivity = true } = {}) {
    if (!workspaceRegistry || typeof workspaceRegistry.archiveSession !== 'function') {
      throw new Error('workspaceRegistry.archiveSession is not available');
    }
    await workspaceRegistry.archiveSession(sessionId, { stopActivity });
    logger(`DSH 会话已归档：${sessionId}`);
  }

  /** 把开机包作为 developer/message 注入日会话；不产生 user turn。 */
  async function injectContext(sessionId, text) {
    if (!text || !String(text).trim()) throw new Error('boot pack text is empty');
    if (!sessions || typeof sessions.get !== 'function') throw new Error('sessions service is not available');
    const session = sessions.get(sessionId);
    if (!session || typeof session.append !== 'function') throw new Error(`session not found: ${sessionId}`);
    // 开机包只属于“新会话第一轮之前”。已有对话事件的会话（尤其是用户在 DSH 里
    // 手动创建的 91c）不能再塞 developer/message，否则会打乱 turn 边界。
    let hasDialogue = false;
    let hasSnapshot = false;
    try {
      if (typeof session.snapshotEvents === 'function') {
        hasSnapshot = true;
        hasDialogue = session.snapshotEvents().some((event) => (
          event?.type === 'turn/start'
          || event?.type === 'user/message'
          || event?.type === 'assistant/message'
        ));
      }
    } catch {}
    if (!hasSnapshot) {
      const seq = Number(session.seq);
      if (Number.isSafeInteger(seq) && seq > 0) hasDialogue = true;
    }
    if (hasDialogue) return { seq: null, skipped: true };
    const event = session.append(
      'developer/message',
      {
        // DSH v4 developer/message 是带 turn/step 的会话事件；缺字段会让整个 session
        // 落入格式错误（"turn must be a non-negative safe integer"）。
        turn: 1,
        step: 1,
        message: {
          // DSH v4 developer message 必须是完整消息：id + producer-owned source。
          id: randomUUID(),
          role: 'developer',
          content: [{ type: 'text', text: String(text) }],
          source: { kind: 'onefish-core' },
        },
      },
      { surfaceOp: 'append' },
    );
    return { seq: event?.seq ?? null };
  }

  return { ensureWorkspace, createDaily, history, archive, injectContext };
}
