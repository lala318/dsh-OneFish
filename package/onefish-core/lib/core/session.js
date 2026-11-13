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
import { dayKeyOf, normalizeDayKey } from './day.js';
import { createSessionIndexStore } from './session-index.js';
import { DEFAULT_CONFIG } from './config.js';

function safeLimit(value, fallback = 20, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

export function createSessionService({
  paths,
  adapter = null,
  archive = null,
  config = DEFAULT_CONFIG,
  logger = () => {},
  now = () => Date.now(),
} = {}) {
  const index = createSessionIndexStore({ paths });
  const options = { ...DEFAULT_CONFIG, ...config };
  let ensureInflight = null;
  const consolidateInflight = new Map();

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
    state.active = {
      ...state.active,
      lastActivityAt: now(),
      eventCount: Number(state.active.eventCount || 0) + (type && type !== 'heartbeat' ? 1 : 0),
      lastEventType: type || state.active.lastEventType || '',
    };
    index.write(state);
    return state.active;
  }

  async function createDaily(day) {
    if (!adapter) throw new Error('DSH session adapter is not available');
    const title = `${options.titlePrefix} ${day}`;
    const created = await adapter.createDaily({ preset: options.preset, title, day });
    const sessionId = String(created?.sessionId || '').trim();
    if (!sessionId) throw new Error('DSH session.create returned no sessionId');
    return {
      day,
      sessionId,
      preset: String(created?.preset || options.preset),
      createdAt: now(),
      lastActivityAt: now(),
      eventCount: 0,
      status: 'active',
    };
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
      const state = index.read();
      if (state.active?.day === day) return { ...state.active, created: false, reused: true };
      const previous = state.active;
      const created = await createDaily(day);
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
      logger(`日会话已创建：${day} / ${created.sessionId}`);
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
    runPending,
    retire,
    noteActivity,
    bootstrap,
  };
}
