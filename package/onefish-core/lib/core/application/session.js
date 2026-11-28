/**
 * 日会话生命周期。
 *
 * DSH 拥有会话运行时和消息历史；这里只负责：
 *   - day → sessionId 索引
 *   - 每天新建 / 封存
 *   - 把封存会话整理进全量档案
 *
 * 不保存消息正文，不组装上下文。
 */
import { dayKeyOf, normalizeDayKey } from '../domain/day.js';
import { DEFAULT_CONFIG } from '../domain/config.js';
import { timestampText } from '../domain/timestamp.js';
import { userMessageText } from './recall.js';
import { normalizeRecords } from '../domain/consolidation.js';

function safeLimit(value, fallback = 20, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

export function createSessionService({
  sessionIndex,
  adapter = null,
  archive = null,
  bootPack = null,
  recall = null,
  memoryMaintenance = null,
  memoryConsolidator = null,
  daySummarizer = null,
  config = DEFAULT_CONFIG,
  logger = () => {},
  now = () => Date.now(),
} = {}) {
  if (!sessionIndex) throw new Error('session index store is required');
  const index = sessionIndex;
  const options = { ...DEFAULT_CONFIG, ...config };
  let ensureInflight = null;
  const consolidateInflight = new Map();
  // 只在本进程里盯住首轮：system/message 落盘前不许写 developer/message。
  const surfaceReady = new Set();
  // 每个会话最近一次打开的 turn/step：user/message 自带的事件里没有 turn/step，
  // 召回注入时要用这一个；进程重启后由下一个 step/start 重新学习。
  const openStep = new Map();
  // 每轮最多注入一次召回；同一 turn 里后续 step 不再插。
  const recallTurn = new Map();

  function currentDay() {
    return dayKeyOf(now(), { rolloverHour: options.rolloverHour });
  }

  function current() {
    return index.read().active;
  }

  function list({ limit = 20 } = {}) {
    const state = index.read();
    const rows = [
      ...(state.active ? [{ ...state.active, state: 'active' }] : []),
      ...state.recent.map((item) => ({ ...item, state: item.status })),
    ];
    return rows.slice(0, safeLimit(limit, 20, 100));
  }

  function stats() {
    const state = index.read();
    const activeDay = currentDay();
    return {
      active: Boolean(state.active),
      day: state.active?.day || '',
      sessionId: state.active?.sessionId || '',
      workspaceId: state.active?.workspaceId || '',
      workspaceTitle: state.active?.workspaceTitle || '',
      bootPackAt: state.active?.bootPackAt || 0,
      bootPackStatus: state.active?.bootPackStatus || '',
      lastTimestampTurn: state.active?.lastTimestampTurn || 0,
      lastTimestampAt: state.active?.lastTimestampAt || 0,
      timestampError: state.active?.timestampError || '',
      workspaceAttached: state.active?.workspaceAttached === true,
      currentDay: activeDay,
      recent: state.recent.length,
      pending: state.recent.filter((item) => item.status === 'pending' || item.status === 'failed').length,
      consolidated: state.recent.filter((item) => item.status === 'consolidated').length,
      retired: state.recent.filter((item) => item.status === 'retired').length,
    };
  }

  function status() {
    const state = index.read();
    return {
      active: state.active,
      recent: state.recent,
      stats: stats(),
      config: {
        rolloverHour: options.rolloverHour,
        preset: options.preset,
        titlePrefix: options.titlePrefix,
        workspaceTitle: options.workspaceTitle,
        workspacePath: options.workspacePath,
        bootMaxChars: options.bootMaxChars,
        autoConsolidate: options.autoConsolidate,
      },
    };
  }

  function noteActivity(sessionId, event = {}) {
    const id = String(sessionId || '').trim();
    if (!id) return null;
    const state = index.read();
    if (!state.active || state.active.sessionId !== id) return null;
    const type = String(event?.type || event?.event?.type || '').trim();
    const isMessage = type === 'user/message' || type === 'assistant/message';
    state.active = {
      ...state.active,
      lastActivityAt: now(),
      eventCount: Number(state.active.eventCount || 0) + (isMessage ? 1 : 0),
      lastEventType: type || state.active.lastEventType || '',
    };
    index.write(state);
    return state.active;
  }

  async function ensureWorkspace() {
    if (!options.workspacePath || !adapter || typeof adapter.ensureWorkspace !== 'function') return null;
    try {
      return await adapter.ensureWorkspace({
        path: options.workspacePath,
        title: options.workspaceTitle,
      });
    } catch (error) {
      logger(`DSH workspace 准备失败 ${options.workspacePath}：${error?.message ?? error}`);
      return null;
    }
  }

  async function applyBootPack(entry, { turn, step } = {}) {
    if (!bootPack || !adapter || typeof adapter.injectContext !== 'function') {
      return { ...entry, bootPackStatus: 'skipped', bootPackAt: now(), bootPackChars: 0, bootPackError: 'boot pack unavailable' };
    }
    if (entry?.bootPackStatus === 'injected') return entry;
    const turnNo = Number(turn);
    const stepNo = Number(step);
    if (!Number.isSafeInteger(turnNo) || turnNo < 0 || !Number.isSafeInteger(stepNo) || stepNo < 0) {
      logger(`开机包跳过：${entry?.sessionId || '?'} 没有 open turn/step，不写入非法 developer/message`);
      return {
        ...entry,
        bootPackStatus: 'skipped',
        bootPackAt: now(),
        bootPackChars: 0,
        bootPackError: 'no open turn/step',
      };
    }
    try {
      const text = bootPack.build({ day: entry.day, workspace: entry });
      const injected = await adapter.injectContext(entry.sessionId, text, { turn: turnNo, step: stepNo });
      if (injected?.skipped) {
        logger(`开机包跳过：${entry.sessionId} ${injected.reason || 'open turn/step 不可用'}`);
        return {
          ...entry,
          bootPackStatus: 'skipped',
          bootPackAt: now(),
          bootPackChars: 0,
          bootPackError: String(injected.reason || 'open turn/step 不可用'),
        };
      }
      logger(`开机包已注入：${entry.day} / ${entry.sessionId}（${text.length} 字，turn ${turnNo}/step ${stepNo}）`);
      return {
        ...entry,
        bootPackStatus: 'injected',
        bootPackAt: now(),
        bootPackChars: text.length,
        bootPackError: '',
      };
    } catch (error) {
      logger(`开机包注入失败 ${entry.sessionId}：${error?.message ?? error}`);
      return {
        ...entry,
        bootPackStatus: 'failed',
        bootPackAt: 0,
        bootPackChars: 0,
        bootPackError: String(error?.message ?? error),
        lastError: String(error?.message ?? error),
      };
    }
  }

  /** 在 open step 内一次性注入开机包（可选）和本轮时间戳。 */
  async function applyTurnContext(entry, { turn, step } = {}) {
    const turnNo = Number(turn);
    const stepNo = Number(step);
    if (!adapter || typeof adapter.injectContext !== 'function') {
      return { ...entry, bootPackStatus: entry.bootPackStatus === 'pending' ? 'skipped' : entry.bootPackStatus, bootPackError: 'adapter unavailable' };
    }
    const bootPending = entry.bootPackStatus === 'pending' || entry.bootPackStatus === 'injecting';
    const timestampDue = options.timestamp?.enabled !== false
      && stepNo === 1
      && turnNo !== Number(entry.lastTimestampTurn || 0);
    if (!bootPending && !timestampDue) return entry;

    const bootText = bootPending
      ? (bootPack ? bootPack.build({ day: entry.day, workspace: entry }) : '')
      : '';
    const parts = [];
    if (bootText) parts.push(bootText);
    if (timestampDue) parts.push(timestampText(now()));
    const text = parts.filter(Boolean).join('\n\n');
    if (!text) {
      return {
        ...entry,
        ...(bootPending ? { bootPackStatus: 'skipped', bootPackAt: now(), bootPackChars: 0, bootPackError: 'boot pack unavailable' } : {}),
        ...(timestampDue ? { timestampInjectingTurn: 0, timestampError: 'timestamp text empty' } : {}),
      };
    }

    const injected = await adapter.injectContext(entry.sessionId, text, { turn: turnNo, step: stepNo });
    if (injected?.skipped) {
      return {
        ...entry,
        ...(bootPending ? { bootPackStatus: 'skipped', bootPackAt: now(), bootPackChars: 0, bootPackError: String(injected.reason || 'open turn/step 不可用') } : {}),
        ...(timestampDue ? { timestampInjectingTurn: 0, timestampError: String(injected.reason || 'open turn/step 不可用') } : {}),
      };
    }
    return {
      ...entry,
      ...(bootPending ? {
        bootPackStatus: 'injected',
        bootPackAt: now(),
        bootPackChars: bootText.length,
        bootPackError: '',
      } : {}),
      ...(timestampDue ? {
        lastTimestampTurn: turnNo,
        lastTimestampAt: now(),
        timestampInjectingTurn: 0,
        timestampError: '',
      } : {}),
    };
  }

  /** 首轮等 system/message 落盘后再注入开机包和时间戳，避免在它之前写坏 DSH 会话。 */
  /**
   * 用户消息落地后，把最相关的旧记忆补一条 developer/message 到当前 open step。
   * 纯同步打分（不走向量），注入失败只记日志，不影响这一轮回复。
   */
  async function applyRecall(sessionId, data = {}) {
    if (!recall || typeof recall.build !== 'function') return null;
    if (!adapter || typeof adapter.injectContext !== 'function') return null;
    const text = userMessageText({ data });
    let built = null;
    try {
      const timeoutMs = Math.max(100, Number(options.recall?.timeoutMs) || 600);
      built = await Promise.race([
        recall.build({ text }),
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ text: '', items: [], reason: 'timeout' }), timeoutMs);
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ]);
    } catch (error) {
      logger(`记忆召回构建失败：${error?.message ?? error}`);
      return null;
    }
    if (!built?.text) return null;
    const open = openStep.get(sessionId);
    if (!open) return null;
    const turnNo = Number(open.turn);
    if (options.recall?.skipFirstTurn !== false && turnNo <= 1) return null;
    if (recallTurn.get(sessionId) === turnNo) return null;
    try {
      const injected = await adapter.injectContext(sessionId, built.text, { turn: turnNo, step: Number(open.step) });
      if (injected?.skipped) {
        logger(`记忆召回跳过：${sessionId} ${injected.reason || 'open turn/step 不可用'}`);
        return null;
      }
      recallTurn.set(sessionId, turnNo);
      index.updateActive({
        lastRecallTurn: turnNo,
        lastRecallAt: now(),
        lastRecallChars: built.text.length,
        lastRecallError: '',
      });
      logger(`记忆召回已注入：turn ${turnNo} / ${built.items?.length || 0} 条`);
      return injected;
    } catch (error) {
      const message = String(error?.message ?? error);
      index.updateActive({ lastRecallError: message });
      logger(`记忆召回注入失败：${message}`);
      return null;
    }
  }

  async function handleEvent(sessionId, event = {}) {
    const id = String(sessionId || '').trim();
    if (!id) return null;
    const type = String(event?.type || event?.event?.type || '').trim();
    const state = index.read();
    if (!state.active || state.active.sessionId !== id) return null;
    const data = event?.data || event?.event?.data || {};
    const turn = Number(data.turn);
    const step = Number(data.step);
    if (type === 'step/start' && Number.isSafeInteger(turn) && turn >= 0 && Number.isSafeInteger(step) && step >= 0) {
      openStep.set(id, { turn, step });
    }
    if (type === 'user/message') return applyRecall(id, data);
    if (type !== 'step/start' && type !== 'system/message') return null;
    if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(step) || turn < 0 || step < 0) return null;

    const active = state.active;
    const bootPending = active.bootPackStatus === 'pending';
    // DSH 要求 system/message 是会话 surface 的第一条；首轮先等它落下来，
    // 否则日志冷加载会报 system/message requires a protected first surface head。
    if (type === 'system/message') surfaceReady.add(id);
    if (type === 'step/start' && turn <= 1 && !surfaceReady.has(id)) return null;
    const timestampDue = options.timestamp?.enabled !== false
      && step === 1
      && turn !== Number(active.lastTimestampTurn || 0)
      && turn !== Number(active.timestampInjectingTurn || 0);
    if (!bootPending && !timestampDue) return null;

    // 先写 injecting，避免同一个 step 的重复事件并发注入两次。
    const patch = {};
    if (bootPending) {
      patch.bootPackStatus = 'injecting';
      patch.bootPackError = '';
    }
    if (timestampDue) patch.timestampInjectingTurn = turn;
    const injecting = index.updateActive(patch);
    if (!injecting) return null;

    try {
      const updated = await applyTurnContext(injecting, { turn, step });
      const next = {};
      if (bootPending) {
        next.bootPackStatus = updated.bootPackStatus;
        next.bootPackAt = updated.bootPackAt;
        next.bootPackChars = updated.bootPackChars;
        next.bootPackError = updated.bootPackError || '';
        if (updated.lastError) next.lastError = updated.lastError;
      }
      if (timestampDue) {
        next.lastTimestampTurn = updated.lastTimestampTurn || injecting.lastTimestampTurn || 0;
        next.lastTimestampAt = updated.lastTimestampAt || injecting.lastTimestampAt || 0;
        next.timestampInjectingTurn = updated.timestampInjectingTurn || 0;
        next.timestampError = updated.timestampError || '';
      }
      if (updated.timestampError) next.timestampError = updated.timestampError;
      return index.updateActive(next);
    } catch (error) {
      const message = String(error?.message ?? error);
      // 事件 publish 期间 append 会被 DSH 拒绝；这是可重试状态，不要永久失败。
      const retryable = /cannot reenter|another append is being published/i.test(message);
      logger(`开机包/时间戳 step/start 注入${retryable ? '延后重试' : '失败'} ${id}：${message}`);
      const next = { timestampInjectingTurn: 0, timestampError: message };
      if (bootPending) {
        next.bootPackStatus = retryable ? 'pending' : 'failed';
        next.bootPackAt = 0;
        next.bootPackChars = 0;
        next.bootPackError = message;
        if (!retryable) next.lastError = message;
      }
      return index.updateActive(next);
    }
  }

  async function createDaily(day, workspace = null) {
    if (!adapter) throw new Error('DSH session adapter is not available');
    const title = `${options.titlePrefix} ${day}`;
    const created = await adapter.createDaily({
      preset: options.preset,
      title,
      day,
      workspaceId: workspace?.workspaceId || '',
      cwd: workspace?.workspacePath || options.workspacePath,
    });
    const sessionId = String(created?.sessionId || '').trim();
    if (!sessionId) throw new Error('DSH session.create returned no sessionId');
    const workspaceRequired = Boolean(workspace?.workspaceId);
    const workspaceAttached = created?.workspaceAttached === true;
    const workspaceAttachError = String(created?.workspaceAttachError || '');
    if (workspaceRequired && !workspaceAttached && workspaceAttachError) {
      logger(`日会话 workspace 未 attach：${sessionId} / ${workspaceAttachError}`);
    }
    const entry = {
      day,
      sessionId,
      preset: String(created?.preset || options.preset),
      workspaceId: String(workspace?.workspaceId || ''),
      workspaceTitle: String(workspace?.workspaceTitle || ''),
      workspacePath: String(workspace?.workspacePath || options.workspacePath || ''),
      workspaceAttached: workspaceRequired ? workspaceAttached : true,
      createdAt: now(),
      lastActivityAt: now(),
      eventCount: 0,
      status: 'active',
      bootPackAt: 0,
      bootPackChars: 0,
      bootPackStatus: 'pending',
      bootPackError: '',
      lastTimestampTurn: 0,
      lastTimestampAt: 0,
      timestampInjectingTurn: 0,
      timestampError: '',
      lastError: workspaceAttachError,
    };
    return entry;
  }

  function sameWorkspace(active, workspace) {
    if (!workspace) return true;
    return String(active?.workspaceId || '') === String(workspace.workspaceId || '');
  }

  /** 归档某天（DSH archive，不删除历史）；归档失败不阻塞整理。 */
  async function archiveDay(dayInput) {
    const day = normalizeDayKey(dayInput);
    const entry = index.find(day);
    if (!entry) throw new Error(`no session index for ${day}`);
    if (entry.archivedAt) return { ...entry, skipped: true };
    if (!adapter || typeof adapter.archive !== 'function') throw new Error('DSH session adapter archive is not available');
    await adapter.archive(entry.sessionId, { stopActivity: true });
    const updated = index.updateRecent(day, { archivedAt: now() });
    return updated || { ...entry, archivedAt: now() };
  }

  async function ensureToday() {
    if (ensureInflight) return ensureInflight;
    ensureInflight = (async () => {
      const day = currentDay();
      const workspace = await ensureWorkspace();
      const state = index.read();
      if (state.active?.day === day && sameWorkspace(state.active, workspace)) {
        let active = state.active;
        if (active.workspaceId && adapter && typeof adapter.attachWorkspace === 'function') {
          try {
            const attached = await adapter.attachWorkspace(active.sessionId, {
              workspaceId: active.workspaceId,
              path: active.workspacePath || options.workspacePath,
            });
            if (attached?.attached) {
              active = index.updateActive({ workspaceAttached: true, lastError: '' }) || active;
            } else if (attached?.error) {
              active = index.updateActive({ workspaceAttached: false, lastError: attached.error }) || active;
            }
          } catch (error) {
            const message = String(error?.message ?? error);
            logger(`日会话 workspace attach 重试失败 ${active.sessionId}：${message}`);
            active = index.updateActive({ workspaceAttached: false, lastError: message }) || active;
          }
        }
        if (active.bootPackStatus === 'failed' && !active.bootPackAt) {
          active = index.updateActive({
            bootPackStatus: 'pending',
            bootPackError: '',
            lastError: '',
          }) || active;
        }
        if (active.bootPackStatus === 'pending' && Number(active.eventCount || 0) > 0) {
          // 首个 step 已经过去，但不要在 ensureToday 里放弃：保留 pending，
          // 下一个 step/start 仍可安全注入（不能回到第一轮，但至少不丢内容）。
          active = index.updateActive({ bootPackError: 'waiting for next open step' }) || active;
        } else if (!active.bootPackStatus && !active.bootPackAt) {
          const injected = await applyBootPack(active, {});
          active = index.updateActive({
            bootPackStatus: injected.bootPackStatus,
            bootPackAt: injected.bootPackAt,
            bootPackChars: injected.bootPackChars,
            bootPackError: injected.bootPackError || '',
          }) || injected;
        }
        return { ...active, created: false, reused: true };
      }
      const previous = state.active;

      // 同一天但 workspace 变了：只有空会话可以无缝迁移；
      // 有消息的会话不强行搬，留给用户/后续迁移工具处理。
      if (previous && previous.day === day && !sameWorkspace(previous, workspace)) {
        if (Number(previous.eventCount || 0) > 0) {
          logger(`日会话 workspace 不一致，但当前会话已有消息，保留原会话 ${previous.sessionId}`);
          return { ...previous, created: false, reused: true, workspaceMismatch: true };
        }
        const created = await createDaily(day, workspace);
        index.sealActive({ status: 'retired', sealedAt: now() });
        try {
          await adapter.archive(previous.sessionId, { stopActivity: true });
          index.updateRecent(previous.day, { archivedAt: now() });
        } catch (error) {
          logger(`旧 workspace 会话归档失败 ${previous.sessionId}：${error?.message ?? error}`);
        }
        index.setActive(created);
        logger(`日会话已迁移到 workspace：${day} / ${created.sessionId}`);
        return { ...created, created: true, previousDay: previous.day, migrated: true };
      }

      const created = await createDaily(day, workspace);
      if (previous) {
        index.sealActive({ status: 'pending', sealedAt: now() });
        if (options.autoConsolidate) {
          // 封存后先归档旧会话，再异步整理；整理失败留 pending。
          queueMicrotask(() => {
            archiveDay(previous.day)
              .catch((error) => logger(`旧会话归档失败 ${previous.day}：${error?.message ?? error}`))
              .finally(() => consolidateDay(previous.day).catch((error) => {
                logger(`日终整理失败 ${previous.day}：${error?.message ?? error}`);
              }));
          });
        }
      }
      index.setActive(created);
      logger(`日会话已创建：${day} / ${created.sessionId}${workspace ? ` @ ${workspace.workspaceTitle}` : ''}`);
      return { ...created, created: true, previousDay: previous?.day || '' };
    })().finally(() => {
      ensureInflight = null;
    });
    return ensureInflight;
  }

  function seal(dayInput) {
    const day = normalizeDayKey(dayInput);
    const state = index.read();
    if (state.active?.day === day) {
      const sealed = index.sealActive({ status: 'pending', sealedAt: now() });
      logger(`日会话已封存：${day}`);
      return sealed;
    }
    return state.recent.find((item) => item.day === day) || null;
  }

  async function consolidateDay(dayInput, { force = false } = {}) {
    const day = normalizeDayKey(dayInput);
    const entry = index.find(day);
    if (!entry) throw new Error(`no session index for ${day}`);
    if (entry.state === 'active' || entry.day === index.read().active?.day) {
      throw new Error(`cannot consolidate active day ${day}; seal it first`);
    }
    if (!force && entry.status === 'consolidated' && entry.archivePath) {
      return { ...entry, skipped: true };
    }
    if (consolidateInflight.has(day)) return consolidateInflight.get(day);
    const task = (async () => {
      if (!adapter) throw new Error('DSH session adapter is not available');
      if (!archive) throw new Error('archive service is not available');
      const records = await adapter.history(entry.sessionId);
      const result = archive.consolidateDay({ day, sessionId: entry.sessionId, records });
      const updated = index.updateRecent(day, {
        status: 'consolidated',
        archivePath: result.archivePath,
        digestPath: result.digestPath,
        sourceHash: result.sourceHash,
        consolidatedAt: now(),
        attempts: Number(entry.attempts || 0) + 1,
        lastError: '',
      });
      if (memoryMaintenance) {
        try {
          await memoryMaintenance({ day, digestPath: result.digestPath, sessionId: entry.sessionId });
        } catch (error) {
          logger(`夜间记忆整理失败 ${day}：${error?.message ?? error}`);
        }
      }
      if (memoryConsolidator) {
        try {
          const digest = archive?.readDigest ? archive.readDigest(day) : '';
          const events = archive?.readDay ? archive.readDay(day) : [];
          await memoryConsolidator({ day, digest, events, sessionId: entry.sessionId });
        } catch (error) {
          logger(`模型记忆提炼失败 ${day}：${error?.message ?? error}`);
        }
      }
      if (daySummarizer && archive && result.count > 0) {
        try {
          const existing = archive.readSummary?.(day);
          if (force || !existing || existing.sourceHash !== result.sourceHash) {
            const messages = normalizeRecords(records);
            const text = await daySummarizer.summarize({
              day,
              messages,
              skipPrefixes: options.recall?.skipPrefixes || [],
            });
            if (text) archive.writeSummary(day, { text, sourceHash: result.sourceHash });
          }
        } catch (error) {
          logger(`日摘要压缩失败 ${day}：${error?.message ?? error}`);
        }
      }
      logger(`日终整理完成：${day}（${result.count} 条消息）`);
      return { ...(updated || entry), ...result, skipped: Boolean(result.skipped) };
    })().catch((error) => {
      index.updateRecent(day, {
        status: 'failed',
        attempts: Number(entry.attempts || 0) + 1,
        lastError: String(error?.message ?? error),
      });
      throw error;
    }).finally(() => {
      consolidateInflight.delete(day);
    });
    consolidateInflight.set(day, task);
    return task;
  }

  async function runPending({ limit = 10 } = {}) {
    const rows = index.read().recent
      .filter((item) => item.status === 'pending' || item.status === 'failed')
      .slice(0, safeLimit(limit, 10, 100));
    const results = [];
    for (const row of rows) {
      if (!row.archivedAt) {
        try {
          results.push(await archiveDay(row.day));
        } catch (error) {
          results.push({ day: row.day, archiveError: String(error?.message ?? error) });
        }
      }
      try {
        results.push(await consolidateDay(row.day));
      } catch (error) {
        results.push({ day: row.day, error: String(error?.message ?? error) });
      }
    }
    return results;
  }

  async function retire(sessionId) {
    const id = String(sessionId || '').trim();
    if (!id) throw new Error('sessionId is required');
    if (!adapter) throw new Error('DSH session adapter is not available');
    await adapter.archive(id, { stopActivity: true });
    const state = index.read();
    if (state.active?.sessionId === id) {
      index.sealActive({ status: 'retired', sealedAt: now() });
    }
    let found = null;
    for (const item of index.read().recent) {
      if (item.sessionId === id) found = index.updateRecent(item.day, { status: 'retired', archivedAt: now() });
    }
    return found || { sessionId: id, archivedAt: now() };
  }

  async function bootstrap() {
    const result = await ensureToday();
    if (options.consolidateOnBootstrap) {
      queueMicrotask(() => {
        runPending().catch((error) => logger(`启动补整理失败：${error?.message ?? error}`));
      });
    }
    return result;
  }

  return {
    current,
    list,
    stats,
    status,
    ensureToday,
    seal,
    archiveDay,
    consolidateDay,
    applyBootPack,
    handleEvent,
    runPending,
    retire,
    noteActivity,
    bootstrap,
  };
}
