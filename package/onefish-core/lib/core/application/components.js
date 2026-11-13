/**
 * 组件注册表：manifest 校验、生命周期、scoped handle、outbound 订阅。
 *
 * 这一层不读文件；状态目录由 component-store 注入。
 */
import { COMPONENT_API_VERSION, validateComponentManifest } from '../domain/component-manifest.js';

function semverSatisfies(actual, range) {
  const a = String(actual || '').split('.').map(Number);
  const r = String(range || '').trim();
  if (!r) return true;
  if (r.startsWith('^')) {
    const w = r.slice(1).split('.').map(Number);
    return a[0] === w[0] && (a[1] > w[1] || (a[1] === w[1] && a[2] >= w[2]));
  }
  return r === actual;
}

export function createComponentRegistry({
  core,
  componentStore,
  version = '0.1.0',
  logger = () => {},
  submit = null,
  config = {},
} = {}) {
  const records = new Map();
  const outboundListeners = new Map();
  let submitFn = submit;

  function setSubmit(fn) {
    submitFn = typeof fn === 'function' ? fn : null;
  }

  function onOutbound(componentId, handler) {
    if (typeof handler !== 'function') throw new Error('outbound handler must be a function');
    let set = outboundListeners.get(componentId);
    if (!set) {
      set = new Set();
      outboundListeners.set(componentId, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  function emitOutbound(componentId, event) {
    const set = outboundListeners.get(componentId);
    if (!set) return 0;
    let count = 0;
    for (const handler of [...set]) {
      try {
        handler(event);
        count += 1;
      } catch (error) {
        logger(`组件 outbound 处理失败 ${componentId}：${error?.message ?? error}`);
      }
    }
    return count;
  }

  function makeScope(manifest) {
    const stateDir = componentStore.ensure(manifest.id);
    return Object.freeze({
      id: manifest.id,
      manifest,
      stateDir,
      config: config.components?.[manifest.id] || {},
      session: Object.freeze({
        ensureToday: (...args) => core.session.ensureToday(...args),
        current: () => core.session.current(),
        submit: async (envelope) => {
          if (!submitFn) throw new Error('component broker is not ready');
          return submitFn(manifest.id, envelope);
        },
        onOutbound: (handler) => onOutbound(manifest.id, handler),
      }),
      persona: Object.freeze({
        get: () => core.persona.get(),
        list: () => core.persona.list(),
        update: (text) => core.persona.update(text),
        block: (opts) => core.persona.block(opts),
      }),
      memory: Object.freeze({
        search: (query, opts) => core.memory.search(query, opts),
        add: (input) => core.memory.add(input),
        update: (id, patch) => core.memory.update(id, patch),
        remove: (id) => core.memory.remove(id),
        list: (opts) => core.memory.list(opts),
        blocks: () => core.memory.blocks(),
      }),
      bootPack: Object.freeze({
        preview: () => {
          const active = core.session.current();
          const status = core.session.status();
          const day = active?.day || status.stats?.currentDay || '';
          return core.bootPack.build({ day, workspace: active });
        },
      }),
    });
  }

  async function register(component) {
    const manifest = validateComponentManifest(component?.manifest);
    if (records.has(manifest.id)) throw new Error(`component already registered: ${manifest.id}`);
    if (!semverSatisfies(version, manifest.core)) {
      throw new Error(`component ${manifest.id} requires core ${manifest.core}, current ${version}`);
    }
    const scope = makeScope(manifest);
    const record = {
      id: manifest.id,
      manifest,
      component,
      scope,
      status: 'starting',
      error: '',
    };
    records.set(manifest.id, record);
    try {
      await component.start?.(scope);
      record.status = 'running';
      logger(`组件已启动：${manifest.id} v${manifest.version}`);
    } catch (error) {
      record.status = 'failed';
      record.error = String(error?.message ?? error);
      logger(`组件启动失败 ${manifest.id}：${record.error}`);
    }
    return {
      id: manifest.id,
      manifest,
      get status() { return record.status; },
      stop: () => stop(manifest.id),
    };
  }

  async function stop(componentId) {
    const record = records.get(componentId);
    if (!record) return false;
    try {
      await record.component.stop?.();
    } catch (error) {
      logger(`组件停止失败 ${componentId}：${error?.message ?? error}`);
    }
    record.status = 'stopped';
    return true;
  }

  function get(componentId) {
    return records.get(componentId) || null;
  }

  function list() {
    return [...records.values()].map((record) => ({
      id: record.id,
      name: record.manifest.name,
      version: record.manifest.version,
      status: record.status,
      error: record.error,
      capabilities: record.manifest.capabilities,
    }));
  }

  function health(componentId) {
    const record = records.get(componentId);
    if (!record) return null;
    return {
      id: record.id,
      status: record.status,
      error: record.error,
      hasStart: typeof record.component.start === 'function',
      hasStop: typeof record.component.stop === 'function',
      hasRenderPrompt: typeof record.component.renderPrompt === 'function',
    };
  }

  return {
    apiVersion: COMPONENT_API_VERSION,
    register,
    stop,
    get,
    list,
    health,
    emitOutbound,
    setSubmit,
  };
}
