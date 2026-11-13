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

  async function createDaily({ preset, title, day } = {}) {
    const created = await sessionController.create({ agentPreset: preset });
    const sessionId = String(created?.sessionId || '').trim();
    if (!sessionId) throw new Error('sessionController.create returned no sessionId');
    if (title && typeof sessionController.rename === 'function') {
      try {
        await sessionController.rename({ sessionId, title });
      } catch (error) {
        logger(`日会话重命名失败 ${sessionId}：${error?.message ?? error}`);
      }
    }
    logger(`DSH 日会话已创建：${day || ''} ${sessionId}`);
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

  return { createDaily, history, archive };
}
