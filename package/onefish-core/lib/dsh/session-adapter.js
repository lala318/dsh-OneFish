/**
 * DSH 会话适配层。
 *
 * Core 只认这里的抽象；DSH 版本变化时改这一层，不改 day/session/archive 规则。
 */
export function createDshSessionAdapter({
  sessionController,
  workspaceRegistry = null,
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

  return { ensureWorkspace, createDaily, history, archive };
}
