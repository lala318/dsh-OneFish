/**
 * 对话时间戳：每轮 user turn 的第一 step 注入一次，避免模型只看到消息正文。
 *
 * 使用本机时区；输出只依赖传入的 at，便于测试。
 */
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

export function formatTimestamp(at = Date.now()) {
  const date = new Date(Number(at) || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return [
    '【当前时间】',
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    `周${WEEKDAYS[date.getDay()] || '?'}`,
  ].join(' ');
}

export function timestampText(at = Date.now()) {
  return formatTimestamp(at);
}
