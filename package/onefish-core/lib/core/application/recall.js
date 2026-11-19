/**
 * 每轮记忆召回：把和这句用户消息最相关的几条记忆拼成一段 developer/message，
 * 在同一轮里注入日会话。
 *
 * 打分优先用 memory.search 的向量+词面混合结果（本地 ONNX，预热后 30ms 上下）；
 * 向量不可用时退回纯词面匹配（中文按二元组），保证没有 embedding 也能召回。
 * 只召回 core / active，knowledge（梗、黑话）默认不进来。
 */
import { DEFAULT_CONFIG } from '../domain/config.js';

function truncate(text, max) {
  const value = String(text || '').trim();
  if (!value || value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function normalize(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 词面兜底：拉丁词 + 中文二元组。 */
export function queryTokens(query) {
  const text = normalize(query);
  const tokens = new Set();
  for (const word of text.match(/[a-z0-9][a-z0-9._-]{1,}/g) || []) tokens.add(word);
  const cjk = text.match(/[\u4e00-\u9fff]+/g) || [];
  for (const run of cjk) {
    if (run.length === 1) tokens.add(run);
    for (let i = 0; i + 1 < run.length; i += 1) tokens.add(run.slice(i, i + 2));
  }
  return [...tokens];
}

export function lexicalRelevance(tokens, row) {
  if (!tokens.length) return 0;
  const haystack = normalize(`${row?.text || ''} ${(row?.tags || []).join(' ')}`);
  if (!haystack) return 0;
  let matched = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) matched += 1;
  }
  return matched / tokens.length;
}

export function createRecallService({ memory, config = DEFAULT_CONFIG, logger = () => {} } = {}) {
  const options = { ...DEFAULT_CONFIG.recall, ...(config?.recall || {}) };

  function skipReason(text) {
    const value = String(text || '').trim();
    if (!value) return 'empty';
    if (value.length < Number(options.minQueryChars || 0)) return 'short';
    for (const prefix of options.skipPrefixes || []) {
      if (prefix && value.startsWith(prefix)) return `prefix:${prefix}`;
    }
    return '';
  }

  function allowed(row) {
    return row.tier === 'core' || row.tier === 'active';
  }

  /** 词面兜底打分（向量不可用或没命中时才用）。 */
  function lexicalPick(query) {
    const tokens = queryTokens(query);
    if (!tokens.length) return [];
    const rows = typeof memory?.recallCandidates === 'function' ? memory.recallCandidates() : [];
    const scored = [];
    for (const row of rows) {
      if (!allowed(row)) continue;
      const relevance = lexicalRelevance(tokens, row);
      if (!relevance) continue;
      const score = 0.7 * relevance + 0.3 * Number(row.score || 0);
      if (score < Number(options.lexicalMinScore || 0.35)) continue;
      scored.push({ ...row, relevance, finalScore: score, source: 'lexical' });
    }
    scored.sort((a, b) => b.finalScore - a.finalScore);
    return scored.slice(0, Number(options.topK) || 3);
  }

  function fromSearchRows(rows) {
    return rows
      .filter((row) => allowed(row)
        && Number(row.score || 0) >= Number(options.minScore || 0)
        && Number(row.relevance || 0) >= Number(options.minRelevance || 0))
      .slice(0, Number(options.topK) || 3)
      .map((row) => ({ ...row, finalScore: Number(row.score || 0), source: 'search' }));
  }

  /** 异步构建；返回 { text, items, reason }。text 为空表示这轮不注入。 */
  async function build({ text } = {}) {
    if (options.enabled === false) return { text: '', items: [], reason: 'disabled' };
    const reason = skipReason(text);
    if (reason) return { text: '', items: [], reason };
    const query = String(text || '').trim().slice(0, Number(options.maxQueryChars) || 800);
    let picked = [];
    let source = 'search';
    try {
      const rows = typeof memory?.search === 'function'
        ? await memory.search(query, { k: Math.max(6, Number(options.topK) * 3) })
        : [];
      picked = fromSearchRows(rows);
    } catch (error) {
      logger(`记忆召回检索失败，退词面兜底：${error?.message ?? error}`);
    }
    if (!picked.length) {
      picked = lexicalPick(query);
      source = 'lexical';
    }
    if (!picked.length) return { text: '', items: [], reason: 'no-hit' };
    const lines = picked.map((row) => `- [${row.tier}] ${truncate(row.text, 150)}`);
    let output = `【记忆召回】可能相关的旧记忆（按当前消息自动挑出）\n${lines.join('\n')}`;
    if (output.length > Number(options.maxChars || 600)) output = truncate(output, Number(options.maxChars) || 600);
    return { text: output, items: picked, source, reason: 'ok' };
  }

  return { build, skipReason, options };
}

/** 从 DSH user/message 事件里取纯文本。 */
export function userMessageText(event = {}) {
  const data = event?.data || event?.event?.data || {};
  const parts = [];
  const content = data?.content ?? data?.message?.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item && item.type === 'text') parts.push(String(item.text || ''));
    }
  } else if (typeof data?.text === 'string') {
    parts.push(data.text);
  }
  return parts.join('\n').replace(/\n{2,}/g, '\n').trim();
}
