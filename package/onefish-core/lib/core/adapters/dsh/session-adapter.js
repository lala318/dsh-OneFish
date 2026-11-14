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
  let workspaceEntity = null;

  async function ensureWorkspace({ path, title } = {}) {
    if (!path || !workspaceRegistry) return null;
    if (workspaceCache && workspaceCache.path === path && workspaceCache.title === title && workspaceEntity) return workspaceCache;
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
    workspaceEntity = workspace;
    workspaceCache = {
      workspaceId: String(workspace.id || ''),
      workspaceTitle: String(workspace.title || title || ''),
      workspacePath: String(workspace.path || path || ''),
    };
    logger(`DSH workspace 已就绪：${workspaceCache.workspaceTitle} (${workspaceCache.workspaceId})`);
    return workspaceCache;
  }

  async function resolveWorkspace({ workspaceId, path } = {}) {
    if (workspaceEntity && (!workspaceId || String(workspaceEntity.id) === String(workspaceId))) return workspaceEntity;
    if (workspaceId && workspaceRegistry && typeof workspaceRegistry.get === 'function') {
      const found = workspaceRegistry.get(workspaceId);
      if (found) return found;
    }
    if (path && workspaceRegistry && typeof workspaceRegistry.resolveByPath === 'function') {
      const found = await workspaceRegistry.resolveByPath(path);
      if (found) return found;
    }
    return null;
  }

  /**
   * 创建后确认会话确实被 workspace 记账；sessionIds 是 DSH UI 的归属依据，
   * 不能只相信 create({ workspaceId }) 的返回值。
   */
  async function attachWorkspace(sessionId, { workspaceId = '', path = '' } = {}) {
    if (!workspaceRegistry) return { attached: false, skipped: true, reason: 'workspaceRegistry unavailable' };
    const workspace = await resolveWorkspace({ workspaceId, path });
    if (!workspace) return { attached: false, skipped: false, error: `workspace not found: ${workspaceId || path || '(empty)'}` };
    const before = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [];
    if (!before.includes(sessionId)) {
      if (typeof workspace.attachSession !== 'function') {
        return { attached: false, skipped: false, error: `workspace ${workspace.id} has no attachSession` };
      }
      await workspace.attachSession(sessionId);
    }
    const after = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [];
    if (!after.includes(sessionId)) {
      return { attached: false, skipped: false, error: `workspace ${workspace.id} did not retain ${sessionId}` };
    }
    return {
      attached: true,
      skipped: false,
      workspaceId: String(workspace.id || workspaceId || ''),
      workspaceTitle: String(workspace.title || ''),
      workspacePath: String(workspace.path || path || ''),
    };
  }

  async function createDaily({ preset, title, day, workspaceId, cwd } = {}) {
    const created = await sessionController.create({
      agentPreset: preset,
      ...(workspaceId ? { workspaceId } : {}),
      ...(!workspaceId && cwd ? { cwd } : {}),
    });
    const sessionId = String(created?.sessionId || '').trim();
    if (!sessionId) throw new Error('sessionController.create returned no sessionId');
    let attached = { attached: false, skipped: true, reason: 'no workspace' };
    if (workspaceId || cwd) {
      try {
        attached = await attachWorkspace(sessionId, { workspaceId, path: cwd });
        if (attached.error) logger(`日会话 workspace attach 失败 ${sessionId}：${attached.error}`);
        else if (attached.attached) logger(`日会话已加入 workspace：${sessionId} -> ${attached.workspaceId}`);
      } catch (error) {
        attached = { attached: false, skipped: false, error: String(error?.message ?? error) };
        logger(`日会话 workspace attach 异常 ${sessionId}：${attached.error}`);
      }
    }
    if (title && typeof sessionController.rename === 'function') {
      try {
        await sessionController.rename({ sessionId, title });
      } catch (error) {
        logger(`日会话重命名失败 ${sessionId}：${error?.message ?? error}`);
      }
    }
    logger(`DSH 日会话已创建：${day || ''} ${sessionId}${workspaceId ? ` @ ${workspaceId}` : ''}`);
    return {
      sessionId,
      preset: String(created?.agentPreset || preset || ''),
      workspaceAttached: attached.attached === true,
      workspaceAttachError: attached.error || '',
    };
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

  /**
   * 把开机包作为 developer/message 注入日会话；不产生 user turn。
   *
   * DSH v4 要求 developer/message 匹配一个已经打开的 turn/step。这里不再
   * 猜 turn=1/step=1；没有显式 open turn/step 时安全跳过，由调用方记录。
   */
  async function injectContext(sessionId, text, { turn, step } = {}) {
    if (!text || !String(text).trim()) throw new Error('boot pack text is empty');
    const turnNo = Number(turn);
    const stepNo = Number(step);
    if (!Number.isSafeInteger(turnNo) || turnNo < 0 || !Number.isSafeInteger(stepNo) || stepNo < 0) {
      return { seq: null, skipped: true, reason: 'no open turn/step' };
    }
    if (!sessions || typeof sessions.get !== 'function') throw new Error('sessions service is not available');
    const session = sessions.get(sessionId);
    if (!session || typeof session.append !== 'function') throw new Error(`session not found: ${sessionId}`);
    const event = session.append(
      'developer/message',
      {
        turn: turnNo,
        step: stepNo,
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

  return { ensureWorkspace, attachWorkspace, createDaily, history, archive, injectContext };
}
