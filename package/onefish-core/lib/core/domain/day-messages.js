/**
 * 一天里哪些消息算“主人/助手真说过的话”。
 * 系统注入的提示（空闲钟、开机包、记忆召回、DSH 的 system-reminder）不算，
 * 提炼摘要和挑重点都以这里为准。
 */
export const INJECTED_PREFIXES = ['【空闲】', '【开机包】', '【记忆召回】', '【OneFish 开机包】', '<system-reminder>'];

export function usableMessages(messages = [], { skipPrefixes = [] } = {}) {
  const prefixes = [...INJECTED_PREFIXES, ...(Array.isArray(skipPrefixes) ? skipPrefixes : [])].filter(Boolean);
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && String(m.text || '').trim())
    .filter((m) => !prefixes.some((p) => String(m.text).trim().startsWith(p)));
}
