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
  let activeSessionId = '';

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
    if (current || queue.length === 0) return;
    const item = queue.shift();
    current = item;
    const record = components?.get?.(item.componentId);
    const extra = typeof record?.component?.renderPrompt === 'function'
      ? record.component.renderPrompt(item.envelope)
      : '';
    try {
      await sessionController.prompt({
        sessionId: activeSessionId,
        requestId: item.requestId,
        mode: 'queue',
        content: [{ type: 'text', text: formatInbound(item.envelope, extra) }],
      });
    } catch (error) {
      logger(`组件 prompt 失败 ${item.componentId}：${error?.message ?? error}`);
      emitError(item, error);
      current = null;
      pump();
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
    };
    queue.push(item);
    pump().catch((error) => logger(`组件队列失败：${error?.message ?? error}`));
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
