/**
 * 归档/摘要脱敏：不把发送令牌等 secret 写进长期历史。
 *
 * 只处理明确的 `token="..."` / `accessToken: "..."` 形态，避免误伤普通文本。
 */
const PATTERNS = [
  /(\btoken\s*=\s*")(?!\[redacted\])([^"\r\n]{8,})(")/gi,
  /(\btoken\s*=\s*')(?!\[redacted\])([^'\r\n]{8,})(')/gi,
  /(\btoken\s*=\s*)(?!\[redacted\])([A-Za-z0-9._~+\/=-]{16,})/gi,
  /(\b(?:accessToken|wsAccessToken|sendToken|apiKey|api_key|secret)\s*[:=]\s*")(?!\[redacted\])([^"\r\n]{8,})(")/gi,
  /(\b(?:accessToken|wsAccessToken|sendToken|apiKey|api_key|secret)\s*[:=]\s*')(?!\[redacted\])([^'\r\n]{8,})(')/gi,
];

export function redactSecrets(text) {
  let value = String(text ?? '');
  for (const pattern of PATTERNS) {
    value = value.replace(pattern, (_match, prefix, _secret, suffix = '') => `${prefix}[redacted]${suffix}`);
  }
  return value;
}

export function hasSecret(text) {
  const value = String(text ?? '');
  return PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}
