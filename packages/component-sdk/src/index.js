/**
 * OneFish Component Contract v1。
 *
 * 只做契约校验和信封 helper，不包含 core 实现，也不 import DSH。
 */
export const API_VERSION = 1;
export const MANIFEST_VERSION = 1;
export const OUTBOUND_MODES = Object.freeze(['auto', 'tool', 'none']);

const ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export class ComponentManifestError extends Error {
  constructor(issues) {
    super(`invalid component manifest: ${issues.join('; ')}`);
    this.name = 'ComponentManifestError';
    this.issues = issues;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bool(value, fallback = false) {
  return value === undefined ? fallback : value === true;
}

/** 校验并归一化 manifest；失败抛 ComponentManifestError。 */
export function validateManifest(input) {
  const issues = [];
  const raw = isObject(input) ? input : {};
  const id = String(raw.id || '').trim();
  const name = String(raw.name || '').trim();
  const version = String(raw.version || '').trim();
  const core = String(raw.core || '').trim();

  if (!ID_RE.test(id)) issues.push('id must match [a-z][a-z0-9-]{1,39}');
  if (!name) issues.push('name is required');
  if (!VERSION_RE.test(version)) issues.push('version must be semver');
  if (Number(raw.manifestVersion) !== MANIFEST_VERSION) issues.push(`manifestVersion must be ${MANIFEST_VERSION}`);
  if (Number(raw.apiVersion) !== API_VERSION) issues.push(`apiVersion must be ${API_VERSION}`);
  if (!core) issues.push('core semver range is required');

  const capabilities = isObject(raw.capabilities) ? raw.capabilities : {};
  const channel = isObject(capabilities.channel) ? capabilities.channel : null;
  let outbound = 'none';
  if (channel) {
    outbound = String(channel.outbound || 'none');
    if (!OUTBOUND_MODES.includes(outbound)) issues.push(`channel.outbound must be one of ${OUTBOUND_MODES.join(', ')}`);
  }

  if (issues.length) throw new ComponentManifestError(issues);

  return Object.freeze({
    manifestVersion: MANIFEST_VERSION,
    id,
    name,
    version,
    apiVersion: API_VERSION,
    core,
    capabilities: Object.freeze({
      channel: channel ? Object.freeze({
        inbound: bool(channel.inbound, true),
        outbound,
      }) : null,
      tools: bool(capabilities.tools),
      jobs: bool(capabilities.jobs),
      context: bool(capabilities.context),
    }),
    state: bool(raw.state, true),
    configSchema: isObject(raw.configSchema) ? raw.configSchema : null,
  });
}

function requiredString(value, field, issues) {
  const text = String(value || '').trim();
  if (!text) issues.push(`${field} is required`);
  return text;
}

/** 校验组件入站信封；componentId 由 Core 的 scoped handle 自动补。 */
export function createInbound(input = {}) {
  const issues = [];
  const channelKey = requiredString(input.channelKey, 'channelKey', issues);
  const text = requiredString(input.text, 'text', issues);
  const requestId = String(input.requestId || '').trim();
  if (!requestId) issues.push('requestId is required');
  if (issues.length) throw new TypeError(`invalid inbound envelope: ${issues.join('; ')}`);
  return Object.freeze({
    channelKey,
    requestId,
    messageId: String(input.messageId || ''),
    user: isObject(input.user) ? Object.freeze({ ...input.user }) : null,
    text,
    attachments: Array.isArray(input.attachments) ? Object.freeze([...input.attachments]) : [],
    replyTo: String(input.replyTo || ''),
    receivedAt: Number(input.receivedAt || Date.now()),
    meta: isObject(input.meta) ? Object.freeze({ ...input.meta }) : {},
  });
}

/** 校验组件出站信封；只由 Core 生成。 */
export function createOutbound(input = {}) {
  const issues = [];
  const componentId = requiredString(input.componentId, 'componentId', issues);
  const channelKey = requiredString(input.channelKey, 'channelKey', issues);
  const requestId = requiredString(input.requestId, 'requestId', issues);
  const kind = String(input.kind || 'assistant');
  if (kind !== 'assistant' && kind !== 'error') issues.push('kind must be assistant or error');
  if (issues.length) throw new TypeError(`invalid outbound envelope: ${issues.join('; ')}`);
  return Object.freeze({
    componentId,
    channelKey,
    requestId,
    turnId: String(input.turnId || ''),
    kind,
    text: String(input.text || ''),
    replyTo: String(input.replyTo || ''),
    at: Number(input.at || Date.now()),
  });
}

/** 简单的 semver 前缀检查；core 侧还会做完整校验。 */
export function coreVersionSatisfies(actual, range) {
  const a = String(actual || '').split('.').map(Number);
  const r = String(range || '').trim();
  if (!r) return true;
  if (r.startsWith('^')) {
    const want = r.slice(1).split('.').map(Number);
    return a[0] === want[0] && (a[1] > want[1] || (a[1] === want[1] && a[2] >= want[2]));
  }
  return r === actual;
}
