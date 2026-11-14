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
  /(\btoken\b[\\"'\s]*:[\\"'\s]*)(?!\[redacted\])([A-Za-z0-9._~+\/=-]{8,})/gi,
  /(【发送令牌】[^\S\r\n]*)(?!\[redacted\])([A-Za-z0-9_-]{8,})/g,
];

export function redactSecrets(text) {
  let value = String(text ?? '');
  for (const pattern of PATTERNS) {
    value = value.replace(pattern, (match, prefix, _secret, suffix) => {
      // 有的 pattern 只有两个 capture group；第三参数是 offset，不是 suffix。
      const ending = typeof suffix === 'string' ? suffix : '';
      return `${prefix}[redacted]${ending}`;
    });
  }
  // 清理早期脱敏器留下的 offset 尾巴（[redacted]1335）。
  value = value.replace(/\[redacted\][0-9]{2,}/g, '[redacted]');
  return value;
}

export function hasSecret(text) {
  const value = String(text ?? '');
  return PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}
