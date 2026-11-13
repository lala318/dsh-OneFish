/**
 * Echo：组件契约的假组件。
 *
 * 只验证 manifest / 生命周期 / inbound / outbound，不接任何真实频道。
 */
import { randomUUID } from 'node:crypto';
import { validateManifest, createInbound } from '@onefish/component-sdk';

export const MANIFEST = validateManifest({
  manifestVersion: 1,
  id: 'echo',
  name: 'Echo',
  version: '0.1.0',
  apiVersion: 1,
  core: '^0.1.0',
  capabilities: {
    channel: { inbound: true, outbound: 'auto' },
    tools: false,
    jobs: false,
    context: true,
  },
  state: true,
});

export function createEchoComponent() {
  let scope = null;
  let unsubscribe = null;
  const received = [];

  const component = {
    manifest: MANIFEST,

    async start(nextScope) {
      scope = nextScope;
      unsubscribe = scope.session.onOutbound((event) => {
        received.push(event);
      });
    },

    async stop() {
      try { unsubscribe?.(); } catch {}
      unsubscribe = null;
      scope = null;
    },

    async health() {
      return {
        id: MANIFEST.id,
        status: scope ? 'running' : 'stopped',
        received: received.length,
      };
    },

    /** 测试入口：模拟频道收到一条消息。 */
    async submit(text, extra = {}) {
      if (!scope) throw new Error('echo component is not started');
      const envelope = createInbound({
        channelKey: extra.channelKey || 'echo:test',
        requestId: extra.requestId || randomUUID(),
        messageId: extra.messageId || randomUUID(),
        user: extra.user || { id: 'echo-user', name: 'Echo Tester' },
        text,
        replyTo: extra.replyTo,
        meta: extra.meta,
      });
      return scope.session.submit(envelope);
    },

    renderPrompt(envelope) {
      return `【Echo】${envelope.channelKey}\n用户：${envelope.user?.name || envelope.user?.id || 'unknown'}`;
    },

    received,
  };

  return component;
}

export const name = 'onefish-component-echo';
export const inject = ['onefishCore'];

export async function apply(ctx) {
  return ctx.onefishCore.components.register(createEchoComponent());
}
