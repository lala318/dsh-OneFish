/**
 * 组件消息 broker（DSH 侧）。
 *
 * 组件只调用 scoped handle 的 session.submit；这里负责：
 *   - 把入站信封包装成 DSH prompt
 *   - 串行排队，避免同一天会话并发 turn
 *   - 把 assistant 文本在 turn/end 交给 auto 模式组件
 *
 * 注意：MVP 用 FIFO 对应 turn；DSH UI 自己发起的 turn 不参与这个队列。
 */
import { randomUUID } from 'node:crypto';
import { contentText } from '../../domain/consolidation.js';

function formatInbound(envelope, extra = '') {
  const user = envelope.user
    ? `${envelope.user.name || ''}${envelope.user.name && envelope.user.id ? ' / ' : ''}${envelope.user.id || ''}`
    : 'unknown';
  return [
    `【频道】${envelope.channelKey}`,
    `【来源】${envelope.componentId || ''}`,
    `【用户】${user || 'unknown'}`,
    extra,
    `【消息】${envelope.text}`,
  ].filter(Boolean).join('\n');
}

function textOfEvent(event) {
  const data = event?.data;
  const message = data?.message ?? data;
  return contentText(message?.content ?? data?.content ?? '').trim();
}

export function createDshComponentBroker({
  core,
  sessionController,
  components,
  logger = () => {},
} = {}) {
  const queue = [];
  let current = null;
  let pumping = false;
  let activeSessionId = '';

  function isAutoMode(item) {
    const record = components?.get?.(item.componentId);
    return record?.manifest?.capabilities?.channel?.outbound === 'auto';
  }

  function formatPrompt(item) {
    const record = components?.get?.(item.componentId);
    const extra = typeof record?.component?.renderPrompt === 'function'
      ? record.component.renderPrompt(item.envelope)
      : '';
    return formatInbound(item.envelope, extra);
  }

  async function sendPrompt(item) {
    const result = await sessionController.prompt({
      sessionId: activeSessionId,
      requestId: item.requestId,
      mode: 'queue',
      content: [{ type: 'text', text: formatPrompt(item) }],
    });
    if (result?.accepted === false) {
      throw new Error(result.error || 'DSH prompt was rejected');
    }
    return result;
  }

  function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // submit 的调用方会 await；这里避免无人等待时出现 unhandled rejection。
    promise.catch(() => {});
    return { promise, resolve, reject };
  }

  function emitError(item, error) {
    const record = components?.get?.(item.componentId);
    if (record?.manifest?.capabilities?.channel?.outbound !== 'auto') return;
    components.emitOutbound(item.componentId, {
      componentId: item.componentId,
      channelKey: item.envelope.channelKey,
      requestId: item.requestId,
      turnId: item.turnId || '',
      kind: 'error',
      text: String(error?.message ?? error),
      replyTo: item.envelope.replyTo || '',
      at: Date.now(),
    });
  }

  async function pump() {
    if (pumping || current || queue.length === 0) return;
    pumping = true;
    try {
      while (!current && queue.length > 0) {
        const item = queue[0];
        if (!isAutoMode(item)) {
          // tool 模式不需要在 Core 侧等 turn/end 聚合 assistant 文本。
          // 立即交给 DSH，让 DSH 自己排队；否则一个丢失的 turn 事件就会
          // 把后续 QQ 消息永久卡在 Core 队列里。
          queue.shift();
          try {
            await sendPrompt(item);
            item.admission?.resolve({
              requestId: item.requestId,
              sessionId: activeSessionId,
              accepted: true,
              queued: false,
            });
          } catch (error) {
            logger(`组件 prompt 失败 ${item.componentId}：${error?.message ?? error}`);
            item.admission?.reject(error);
          }
          continue;
        }

        // auto 模式保留“一次一个 turn”的聚合语义。
        queue.shift();
        current = item;
        try {
          await sendPrompt(item);
        } catch (error) {
          logger(`组件 prompt 失败 ${item.componentId}：${error?.message ?? error}`);
          emitError(item, error);
          current = null;
        }
        if (current) return;
      }
    } finally {
      pumping = false;
      if (!current && queue.length > 0) queueMicrotask(() => { void pump(); });
    }
  }

  async function submit(componentId, envelope) {
    if (!envelope || typeof envelope !== 'object') throw new Error('inbound envelope is required');
    if (!String(envelope.text || '').trim()) throw new Error('inbound text is empty');
    const active = await core.session.ensureToday();
    activeSessionId = active.sessionId;
    const item = {
      componentId,
      requestId: String(envelope.requestId || randomUUID()),
      envelope: { ...envelope, componentId },
      text: '',
      turnId: '',
      started: false,
      admission: null,
    };
    if (!isAutoMode(item)) item.admission = deferred();
    queue.push(item);
    pump().catch((error) => logger(`组件队列失败：${error?.message ?? error}`));
    if (item.admission) return item.admission.promise;
    return { requestId: item.requestId, sessionId: activeSessionId, queued: true };
  }

  function handleEvent(session, event) {
    if (!current) return;
    const sessionId = String(session?.id || event?.sessionId || '');
    if (sessionId && activeSessionId && sessionId !== activeSessionId) return;
    const ev = event?.event && typeof event.event === 'object' ? event.event : event;
    const type = String(ev?.type || '');
    if (type === 'turn/start') {
      current.started = true;
      current.turnId = String(ev?.data?.turnId || ev?.data?.turn || '');
      return;
    }
    if (type === 'assistant/message' && current.started) {
      const text = textOfEvent(ev);
      if (text) current.text = current.text ? `${current.text}\n${text}` : text;
      return;
    }
    if (type !== 'turn/end' || !current.started) return;
    const item = current;
    current = null;
    const record = components?.get?.(item.componentId);
    if (record?.manifest?.capabilities?.channel?.outbound === 'auto') {
      components.emitOutbound(item.componentId, {
        componentId: item.componentId,
        channelKey: item.envelope.channelKey,
        requestId: item.requestId,
        turnId: item.turnId,
        kind: 'assistant',
        text: item.text,
        replyTo: item.envelope.replyTo || '',
        at: Date.now(),
      });
    }
    pump().catch((error) => logger(`组件队列失败：${error?.message ?? error}`));
  }

  return { submit, handleEvent };
}
