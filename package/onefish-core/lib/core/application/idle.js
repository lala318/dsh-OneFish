/**
 * 空闲钟用例：检查日会话空闲时长，必要时向当前会话发一条主动 prompt。
 *
 * 纯概率在 domain/idle-clock；本层只负责状态、节流和调用宿主 prompt。
 */
import { dayKeyOf } from '../domain/day.js';
import { DEFAULT_CONFIG } from '../domain/config.js';
import {
  normalizeIdleClock,
  shouldTriggerIdle,
  nextEligibleAt as computeNextEligibleAt,
  humanDuration,
} from '../domain/idle-clock.js';

export function createIdleClockService({
  store,
  session,
  config = DEFAULT_CONFIG,
  prompt = null,
  logger = () => {},
  now = () => Date.now(),
  random = Math.random,
} = {}) {
  if (!store) throw new Error('idle store is required');
  if (!session) throw new Error('session service is required');
  const options = { ...DEFAULT_CONFIG, ...config };
  let cfg = normalizeIdleClock(options.idleClock || {});
  let busy = false;

  function currentDay() {
    return dayKeyOf(now(), { rolloverHour: options.rolloverHour });
  }

  function active() {
    return session.current ? session.current() : null;
  }

  function idleMs() {
    const current = active();
    const last = Number(current?.lastActivityAt || 0);
    return last > 0 ? Math.max(0, now() - last) : 0;
  }

  function buildPrompt({ idle = idleMs() } = {}) {
    const current = active();
    const at = new Date(now());
    const pad = (n) => String(n).padStart(2, '0');
    const clock = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
    return [
      `【空闲】现在是 ${clock}，距离上次说话已经 ${humanDuration(idle)}。`,
      `【工作区】${current?.workspaceTitle || 'onefish'}`,
      '',
      '这是你自己的时间，不是任务；想做点自己想做的事再做，也可以保持安静。',
      '不要提“系统/空闲钟/概率/触发”，不要为了证明存在而硬找话题。',
    ].join('\n');
  }

  function status() {
    const state = store.read();
    const idle = idleMs();
    const current = active();
    return {
      ok: true,
      enabled: cfg.enabled,
      busy,
      active: Boolean(current),
      sessionId: current?.sessionId || '',
      day: current?.day || '',
      idleMs: idle,
      lastActivityAt: Number(current?.lastActivityAt || 0),
      state,
      config: cfg,
    };
  }

  /** 设置页保存后立即生效；下一次 check 使用新配置。 */
  function configure(patch = {}) {
    cfg = normalizeIdleClock({ ...cfg, ...(patch && typeof patch === 'object' ? patch : {}) });
    return { ok: true, config: cfg, status: status() };
  }

  function preview() {
    return { ok: true, text: buildPrompt(), state: status() };
  }

  async function check({ manual = false } = {}) {
    if (busy) return { fired: false, reason: 'busy' };
    const current = active();
    if (!current) return { fired: false, reason: 'no-active-session' };
    if (!prompt) return { fired: false, reason: 'prompt-unavailable' };
    if (!manual && !cfg.enabled) return { fired: false, reason: 'disabled' };

    const state = store.read();
    const day = currentDay();
    const baseState = state.day === day
      ? state
      : { ...state, day, countToday: 0, lastConsiderAt: 0, nextEligibleAt: 0 };
    const idle = idleMs();
    const decision = shouldTriggerIdle({
      now: now(),
      lastConversationAt: current.lastActivityAt || 0,
      nextEligibleAt: manual ? 0 : baseState.nextEligibleAt,
      config: { ...cfg, enabled: true },
      random,
    });
    if (!manual && !decision.fire) return { fired: false, ...decision };

    busy = true;
    const text = buildPrompt({ idle });
    try {
      await prompt({ sessionId: current.sessionId, text, reason: manual ? 'manual' : decision.reason });
      // 手动「立即想一次」是调试动作：只发一次、只留个时间戳，
      // 不吃今天的额度、也不进冷却，不然点一下就把当天真触发给点没了。
      const next = manual
        ? store.write({
          ...baseState,
          day,
          lastConsiderAt: now(),
          lastManualAt: now(),
          lastIdleMs: idle,
        })
        : store.write({
          ...baseState,
          day,
          countToday: Number(baseState.countToday || 0) + 1,
          lastConsiderAt: now(),
          nextEligibleAt: computeNextEligibleAt(now(), cfg, random),
          lastIdleMs: idle,
        });
      logger(`空闲钟触发：${current.sessionId}（空闲 ${humanDuration(idle)}${manual ? '，手动' : ''}）`);
      return {
        fired: true,
        manual,
        reason: manual ? 'manual' : decision.reason,
        idleMs: idle,
        probability: decision.probability,
        text,
        state: next,
      };
    } catch (error) {
      logger(`空闲钟 prompt 失败：${error?.message ?? error}`);
      return { fired: false, reason: 'prompt-failed', error: String(error?.message ?? error), idleMs: idle };
    } finally {
      busy = false;
    }
  }

  return {
    status,
    preview,
    check,
    buildPrompt,
    configure,
    get config() { return cfg; },
  };
}
