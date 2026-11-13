/**
 * Component Contract v1 的 manifest 规则（Core 侧）。
 *
 * 纯校验，不读文件；SDK 会提供同一契约给组件作者。
 */
export const COMPONENT_API_VERSION = 1;
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

export function validateComponentManifest(input) {
  const issues = [];
  const raw = isObject(input) ? input : {};
  const id = String(raw.id || '').trim();
  const name = String(raw.name || '').trim();
  const version = String(raw.version || '').trim();
  const core = String(raw.core || '').trim();
  if (!ID_RE.test(id)) issues.push('id must match [a-z][a-z0-9-]{1,39}');
  if (!name) issues.push('name is required');
  if (!VERSION_RE.test(version)) issues.push('version must be semver');
  if (Number(raw.manifestVersion) !== 1) issues.push('manifestVersion must be 1');
  if (Number(raw.apiVersion) !== COMPONENT_API_VERSION) issues.push(`apiVersion must be ${COMPONENT_API_VERSION}`);
  if (!core) issues.push('core semver range is required');

  const capabilities = isObject(raw.capabilities) ? raw.capabilities : {};
  const channel = isObject(capabilities.channel) ? capabilities.channel : null;
  const outbound = channel ? String(channel.outbound || 'none') : 'none';
  if (channel && !OUTBOUND_MODES.includes(outbound)) issues.push(`channel.outbound must be ${OUTBOUND_MODES.join(' / ')}`);

  if (issues.length) throw new ComponentManifestError(issues);
  return Object.freeze({
    manifestVersion: 1,
    id,
    name,
    version,
    apiVersion: COMPONENT_API_VERSION,
    core,
    capabilities: Object.freeze({
      channel: channel ? Object.freeze({ inbound: channel.inbound !== false, outbound }) : null,
      tools: capabilities.tools === true,
      jobs: capabilities.jobs === true,
      context: capabilities.context === true,
    }),
    state: raw.state !== false,
    configSchema: isObject(raw.configSchema) ? raw.configSchema : null,
  });
}
