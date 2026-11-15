/**
 * 记忆整理器（memory-consolidate）—— P1。
 *
 * 职责：把一个逻辑日的摘要/原始事件 + 当前记忆空间，整理成一组可校验、可落库的
 * 记忆操作（ops）。这一层不调用 LLM、不直接碰文件：
 *
 *   buildConsolidatePrompt   组装提示词（system / user）；
 *   parseConsolidateOutput   从模型文本里提取 JSON（容忍围栏和前后废话）；
 *   validateConsolidateOps   严格校验配额、id、重复、敏感信息等；
 *   applyConsolidateOps      只通过 memory-space 的 add/update/softDelete 落库。
 *
 * 比旧版更严的边界：
 *   - core 每天最多 2 条，importance 固定 5，confidence ≥ 0.75；
 *   - 所有 op 的 confidence ≥ 0.35，sourceDays 自动补当天；
 *   - 不写密码/令牌/密钥，不重复写已有正文；
 *   - 同一个 id 当天最多被一条 op 处理，避免 update/forget 互相打架；
 *   - core 只能由主人明确要求才 forget（ownerRequested=true）。
 *
 * supersede 的落库语义：旧条目 id 不变，正文改成新事实；旧正文保存在
 * meta.supersededText，meta.supersededAt / meta.supersededDay 记录替换时间。
 */
import { hasSecret } from '../domain/redaction.js';

export const CONSOLIDATE_MAX_OPS = 24;
export const CONSOLIDATE_MAX_CORE_OPS = 2;
export const CONSOLIDATE_CORE_MIN_CONFIDENCE = 0.75;
export const CONSOLIDATE_MIN_CONFIDENCE = 0.35;
export const CONSOLIDATE_TIERS = Object.freeze(['core', 'active', 'knowledge']);
export const CONSOLIDATE_KINDS = Object.freeze([
  'fact', 'preference', 'relation', 'commitment', 'open_loop',
  'slang', 'meme', 'sticker', 'other',
]);
export const CONSOLIDATE_OPERATIONS = Object.freeze([
  'add', 'update', 'merge', 'forget', 'pin', 'unpin', 'supersede',
]);

const MAX_TEXT = 1200;
const MAX_TAGS = 8;
const MAX_TAG_CHARS = 20;
const MAX_SOURCE_DAYS = 30;
const MAX_SOURCE_IDS = 200;
const MAX_REASON = 300;

/** 明显的令牌/密钥形态：prompt 之外再做一层兜底，宁可拒绝也不落库。 */
const TOKEN_SHAPES = [
  /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\b(?=[A-Za-z0-9+/=_-]{32,}\b)(?=[A-Za-z0-9+/=_-]*[A-Za-z])(?=[A-Za-z0-9+/=_-]*\d)[A-Za-z0-9+/=_-]{32,}\b/,
  /(?:密码|口令)\s*(?:是|为|[:=：])\s*\S{4,}/i,
  /(?:password|passwd|pwd)\s*[:=：]\s*\S{4,}/i,
  /(?:api[_-]?key|secret|sendToken|accessToken|wsAccessToken)\s*[:=：]\s*['"]?[A-Za-z0-9._~+/=-]{8,}/i,
  /\btoken\s*[:=：]\s*['"]?[A-Za-z0-9._~+/=-]{8,}/i,
];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value, max = MAX_TEXT) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
}

function clip(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function normalizeDay(value) {
  const day = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : '';
}

/** day 放最前，去重，最多 30 天；调用方传了 day 就一定会包含它。 */
function normalizeDays(days, day = '') {
  const out = [];
  const push = (value) => {
    const text = String(value ?? '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(text) && !out.includes(text)) out.push(text);
  };
  if (day) push(day);
  for (const value of asArray(days)) push(value);
  return out.slice(0, MAX_SOURCE_DAYS);
}

function normalizeIds(ids) {
  return [...new Set(asArray(ids).map((id) => String(id ?? '').trim()).filter(Boolean))].slice(0, MAX_SOURCE_IDS);
}

function normalizeTags(tags) {
  return asArray(tags)
    .map((tag) => String(tag ?? '').trim().slice(0, MAX_TAG_CHARS))
    .filter(Boolean)
    .slice(0, MAX_TAGS);
}

/** 去重用正文指纹：忽略大小写、空白、标点与符号。 */
function normalizeTextKey(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function normalizeConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function clampImportance(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(Math.min(5, Math.max(1, n)));
}

function looksLikeSecret(value) {
  const text = String(value ?? '');
  if (!text) return false;
  if (hasSecret(text)) return true;
  return TOKEN_SHAPES.some((pattern) => pattern.test(text));
}

/** 当前记忆只展示压缩后的一行，避免提示词被长条目撑爆。 */
function compactEntries(rows, max = 60) {
  return asArray(rows).slice(0, max).map((row) => {
    const tags = asArray(row?.tags).length
      ? `（${asArray(row.tags).map((tag) => String(tag)).join('/')}）`
      : '';
    return `- [${row?.id ?? '?'}] ${clip(row?.text ?? '', 220)}${tags}`;
  }).join('\n');
}

function eventLinesOf(events) {
  return asArray(events).slice(-80).map((raw) => {
    const event = typeof raw === 'string' ? { text: raw } : (isObject(raw) ? raw : {});
    const id = event.id ?? event.eventId ?? event.seq ?? '';
    const who = event.who || event.role || event.type || '';
    const text = event.text ?? event.content ?? '';
    const prefix = `${id === '' ? '' : `[${id}] `}${who ? `${who}: ` : ''}`;
    return `- ${prefix}${clip(text, 180)}`;
  }).filter((line) => line !== '- ').join('\n');
}

/**
 * 生成记忆整理提示词。
 *
 * @param {object} input
 * @param {string} input.day 逻辑日（YYYY-MM-DD）
 * @param {string} [input.digest] 当天日摘要
 * @param {Array} [input.events] 当天原始记录（取尾部 80 条）
 * @param {Array} [input.core] 现有 core 条目
 * @param {Array} [input.active] 现有 active 条目
 * @param {Array} [input.knowledge] 现有 knowledge 条目
 * @param {number} [input.maxOps=24] 本次最多允许的 op 数
 * @returns {{system: string, user: string}}
 */
export function buildConsolidatePrompt({
  day,
  digest = '',
  events = [],
  core = [],
  active = [],
  knowledge = [],
  maxOps = CONSOLIDATE_MAX_OPS,
} = {}) {
  const logicalDay = normalizeDay(day) || String(day ?? '').trim() || '（未指定）';
  const requested = Number(maxOps);
  const opLimit = Number.isFinite(requested)
    ? Math.min(CONSOLIDATE_MAX_OPS, Math.max(1, Math.round(requested)))
    : CONSOLIDATE_MAX_OPS;

  const system = [
    '你是 OneFish 的记忆整理器。你的任务不是写日记，而是判断一个逻辑日里有哪些信息值得进入长期记忆空间。',
    '只输出一个 JSON 对象，不要 Markdown、不要解释、不要代码围栏。',
    '',
    '记忆空间分三层：',
    '- core：身份、边界、长期承诺、不可逆事实，以及主人明确要求永远记住的事。每天全量注入，只放稳定、以后还会反复用到的内容。宁缺毋滥，每天最多 2 条；importance 固定为 5，confidence 必须 ≥ 0.75。',
    '- active：偏好、近况、关系、项目事实、未完成的事。以后可能用到，但不是每天都必须看到。',
    '- knowledge：黑话、梗、表情的含义与用法；不常驻注入，按需检索。',
    '',
    '规则：',
    '1. 只根据给定材料（日摘要、原始记录、现有记忆）整理；材料里没有的不要编造，不确定就不写。',
    '2. 压缩成一句能独立理解的话，不要照抄原始对话；保留事实，去掉语气和过程。',
    '3. 绝对不要记录密码、令牌、API key、私密身份信息、别人的隐私或一次性闲聊；发现这类内容直接跳过。',
    '4. 新信息优先 update / merge 已有条目；同一件事不要重复 add，优先更新而不是制造重复。',
    '5. 只有材料明确说明旧事实已作废/已被替代时才 supersede；只有主人明确要求忘记时才 forget core，并带 ownerRequested=true。',
    '6. 每条 op 的 sourceDays 必须包含当前逻辑日；confidence 必须在 0~1 之间；core 的 confidence 必须 ≥ 0.75。',
    '7. 每个 id 当天最多出现在一条 op 里；merge 至少给 2 个已有 id。',
    '8. 没有值得记的内容就返回 {"ops":[]}。',
    '',
    '可用 op：add / update / merge / forget / pin / unpin / supersede。',
    'JSON 格式：',
    '{"ops":[{"op":"add|update|merge|forget|pin|unpin|supersede","id":"已有条目 id（update/forget/pin/unpin/supersede 必填）","ids":["merge 的 2 个以上已有 id"],"space":"master","kind":"fact|preference|relation|commitment|open_loop|slang|meme|sticker|other","tier":"core|active|knowledge","text":"压缩后的一句话（add/update/merge/supersede 必填）","tags":["…"],"importance":1-5,"sourceDays":["YYYY-MM-DD"],"sourceEventIds":["…"],"confidence":0.0-1.0,"reason":"为什么这么整理","ownerRequested":false}]}',
  ].join('\n');

  const user = [
    `当前逻辑日：${logicalDay}`,
    '',
    '【日摘要】',
    String(digest ?? '').trim() || '（没有摘要）',
    '',
    '【原始记录（尾部截取）】',
    eventLinesOf(events) || '（没有原始记录）',
    '',
    '【现有 core】',
    compactEntries(core) || '（空）',
    '',
    '【现有 active】',
    compactEntries(active) || '（空）',
    '',
    '【现有 knowledge】',
    compactEntries(knowledge) || '（空）',
    '',
    `请输出一个 JSON 对象，最多 ${opLimit} 条 ops；core 最多 ${CONSOLIDATE_MAX_CORE_OPS} 条。不要输出 JSON 以外的任何文字。`,
  ].join('\n');

  return { system, user };
}

/** 依次产出文本里的完整 JSON 对象（字符串内的花括号不计数）。 */
function* balancedJsonObjects(text) {
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          yield text.slice(start, i + 1);
          break;
        }
      }
    }
  }
}

/**
 * 从模型输出中解析 `{"ops":[...]}`。
 *
 * 容忍 Markdown 代码围栏和 JSON 前后的说明文字；如果说明文字里也有花括号，
 * 会跳过解析失败或没有 ops 的对象，继续找真正的整理结果。
 *
 * @param {string} text
 * @returns {Array<object>} ops 数组
 */
export function parseConsolidateOutput(text) {
  let raw = String(text ?? '').trim();
  if (!raw) throw new Error('模型返回为空，无法解析记忆整理结果');

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) raw = fenced[1].trim();

  let sawBalanced = false;
  let sawParsedObject = false;
  let lastParseError = null;
  for (const candidate of balancedJsonObjects(raw)) {
    sawBalanced = true;
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch (error) {
      lastParseError = error;
      continue;
    }
    if (!isObject(parsed)) continue;
    sawParsedObject = true;
    if (Array.isArray(parsed.ops)) return parsed.ops;
  }

  if (!sawBalanced) throw new Error('模型输出中没有找到完整的 JSON 对象');
  if (sawParsedObject) throw new Error('记忆整理 JSON 缺少 ops 数组');
  throw new Error(`记忆整理 JSON 解析失败：${lastParseError?.message ?? '未知错误'}`);
}

/**
 * 归一化单条原始 op；不负责存在性、配额等业务校验。
 * 对于已有条目，缺省字段继承旧条目，避免 update 把 core 悄悄降成 active。
 */
function normalizeRawOp(raw, { existingById = new Map(), day = '' } = {}) {
  if (!isObject(raw)) return { error: 'op 必须是对象' };

  const opName = String(raw.op ?? '').trim().toLowerCase();
  if (!CONSOLIDATE_OPERATIONS.includes(opName)) {
    return { error: `未知 op：${opName || '(空)'}` };
  }

  const id = String(raw.id ?? '').trim().slice(0, 120);
  const ids = [...new Set(asArray(raw.ids).map((value) => String(value ?? '').trim()).filter(Boolean))].slice(0, 50);
  // merge 没有单数 id，缺省字段从第一个被合并的条目继承，避免把 core 合并成 active。
  const mergeAnchor = opName === 'merge' && ids.length ? (existingById.get(ids[0]) || null) : null;
  const existing = (id ? (existingById.get(id) || null) : null) || mergeAnchor;

  let tier = CONSOLIDATE_TIERS.includes(raw.tier)
    ? raw.tier
    : (CONSOLIDATE_TIERS.includes(existing?.tier) ? existing.tier : 'active');
  if (opName === 'pin') tier = 'core';
  if (opName === 'unpin') tier = 'active';

  const kind = CONSOLIDATE_KINDS.includes(raw.kind)
    ? raw.kind
    : (CONSOLIDATE_KINDS.includes(existing?.kind) ? existing.kind : 'fact');
  const space = String(raw.space ?? existing?.space ?? 'master').trim().slice(0, 40) || 'master';
  const text = cleanText(raw.text);
  const tags = normalizeTags(raw.tags);

  const rawImportance = Number(raw.importance);
  const importanceProvided = raw.importance !== undefined
    && raw.importance !== null
    && raw.importance !== ''
    && Number.isFinite(rawImportance);
  const inheritedImportance = clampImportance(existing?.importance, 3);

  let importance;
  if (opName === 'pin' || (opName !== 'unpin' && tier === 'core')) importance = 5;
  else if (opName === 'unpin') importance = importanceProvided ? clampImportance(rawImportance, 3) : 3;
  else importance = importanceProvided ? clampImportance(rawImportance, inheritedImportance) : inheritedImportance;

  const rawConfidence = Number(raw.confidence);
  const confidenceProvided = raw.confidence !== undefined
    && raw.confidence !== null
    && raw.confidence !== ''
    && Number.isFinite(rawConfidence);
  const confidence = normalizeConfidence(raw.confidence);

  const sourceDays = normalizeDays(raw.sourceDays, day);
  const sourceEventIds = normalizeIds(raw.sourceEventIds);
  const reason = String(raw.reason ?? '').trim().slice(0, MAX_REASON);
  const ownerRequested = raw.ownerRequested === true;

  const op = {
    op: opName,
    id,
    ids,
    space,
    kind,
    tier,
    text,
    tags,
    importance,
    sourceDays,
    sourceEventIds,
    confidence,
    reason,
  };
  // 只在明确要求时携带，避免正常输出里多一个无意义字段。
  if (ownerRequested) op.ownerRequested = true;

  return {
    op,
    info: { existing, importanceProvided, rawImportance, confidenceProvided, rawConfidence },
  };
}

/**
 * 校验并归一化一组 ops。
 *
 * 返回 `{ ok, ops, errors }`：ok=false 表示至少有一条被拒绝；ops 仍是所有通过校验、
 * 可以安全落库的条目的归一化结果。错误不会静默吞掉。
 *
 * @param {Array<object>} ops
 * @param {{space: object, day: string}} options
 * @returns {{ok: boolean, ops: Array<object>, errors: string[]}}
 */
export function validateConsolidateOps(ops, { space, day } = {}) {
  const errors = [];
  const valid = [];
  const logicalDay = normalizeDay(day);
  if (!logicalDay) return { ok: false, ops: [], errors: ['缺少有效的 day（YYYY-MM-DD）'] };
  if (!space || typeof space.list !== 'function') {
    return { ok: false, ops: [], errors: ['缺少可用的 memory space（需要 list 方法）'] };
  }

  const rawOps = Array.isArray(ops) ? ops : [];
  if (!rawOps.length) return { ok: true, ops: [], errors: [] };

  const existingRows = asArray(space.list({ includeDeleted: false, limit: 0 }));
  const existingById = new Map(existingRows.map((row) => [row.id, row]));
  const takenIds = new Set();
  const acceptedTextKeys = new Set();
  let coreOps = 0;

  for (const raw of rawOps) {
    if (valid.length >= CONSOLIDATE_MAX_OPS) {
      errors.push(`超过每日 ${CONSOLIDATE_MAX_OPS} 条 ops 上限`);
      break;
    }

    const normalized = normalizeRawOp(raw, { existingById, day: logicalDay });
    if (normalized.error) {
      errors.push(normalized.error);
      continue;
    }
    const { op, info } = normalized;
    const requiresText = op.op === 'add' || op.op === 'update' || op.op === 'merge' || op.op === 'supersede';

    if (requiresText && !op.text) {
      errors.push(`${op.op} 缺少 text`);
      continue;
    }

    // 存在性检查：merge 要至少 2 个已有 id；其它带 id 的 op 必须指向已有条目。
    if (op.op === 'merge') {
      if (op.ids.length < 2) {
        errors.push('merge 的 ids 至少需要 2 个已有 id');
        continue;
      }
      const missing = op.ids.filter((id) => !existingById.has(id));
      if (missing.length) {
        errors.push(`merge 的 id 不存在：${missing.join(', ')}`);
        continue;
      }
    } else if (op.op !== 'add') {
      if (!op.id || !existingById.has(op.id)) {
        errors.push(`${op.op} 的 id 不存在：${op.id || '(空)'}`);
        continue;
      }
    }

    // 一个 id 当天最多被一条 op 处理，防止 update/forget/supersede 互相覆盖。
    const targets = op.op === 'merge' ? op.ids : (op.id ? [op.id] : []);
    const conflict = targets.find((id) => takenIds.has(id));
    if (conflict) {
      errors.push(`同一个 id 只能被一条 op 处理：${conflict}`);
      continue;
    }

    if (info.confidenceProvided && (info.rawConfidence < 0 || info.rawConfidence > 1)) {
      errors.push(`${op.op} 的 confidence 必须在 0~1 之间（当前 ${info.rawConfidence}）`);
      continue;
    }
    if (op.confidence < CONSOLIDATE_MIN_CONFIDENCE) {
      errors.push(`${op.op} 的 confidence 太低（${op.confidence}，至少 ${CONSOLIDATE_MIN_CONFIDENCE}）`);
      continue;
    }

    if (looksLikeSecret(op.text) || looksLikeSecret(op.reason) || looksLikeSecret(op.tags.join(' '))) {
      errors.push(`${op.op} 包含疑似密码/令牌/密钥，拒绝写入`);
      continue;
    }

    // 正文去重：排除本条 op 自己要更新/合并的旧条目，并检查同批 ops。
    let textKey = '';
    if (requiresText) {
      textKey = normalizeTextKey(op.text);
      if (textKey) {
        const selfIds = new Set(targets);
        const duplicate = existingRows.find((row) => !selfIds.has(row.id) && normalizeTextKey(row.text) === textKey);
        if (duplicate) {
          errors.push(`重复条目：${clip(op.text, 30)}（已存在于 ${duplicate.id}）`);
          continue;
        }
        if (acceptedTextKeys.has(textKey)) {
          errors.push(`同一批 ops 里重复写入相同正文：${clip(op.text, 30)}`);
          continue;
        }
      }
    }

    if (op.op === 'supersede') {
      const target = existingById.get(op.id);
      if (normalizeTextKey(op.text) === normalizeTextKey(target?.text)) {
        errors.push('supersede 的新事实与旧正文相同，无需替换');
        continue;
      }
    }

    if (op.op === 'forget') {
      const target = existingById.get(op.id);
      if (target?.tier === 'core' && op.ownerRequested !== true) {
        errors.push('forget core 需要主人明确要求（ownerRequested=true）');
        continue;
      }
    }

    // core 的质量与配额。pin 也算 core op；unpin 已归一化到 active。
    if (op.tier === 'core') {
      if (info.importanceProvided && info.rawImportance !== 5) {
        errors.push('core 的 importance 必须是 5');
        continue;
      }
      if (op.confidence < CONSOLIDATE_CORE_MIN_CONFIDENCE) {
        errors.push(`core 的 confidence 必须 ≥ ${CONSOLIDATE_CORE_MIN_CONFIDENCE}`);
        continue;
      }
      if (coreOps >= CONSOLIDATE_MAX_CORE_OPS) {
        errors.push(`core 超过每日 ${CONSOLIDATE_MAX_CORE_OPS} 条上限`);
        continue;
      }
    }

    if (op.tier === 'core') coreOps += 1;
    for (const id of targets) takenIds.add(id);
    if (textKey) acceptedTextKeys.add(textKey);
    valid.push(op);
  }

  return { ok: errors.length === 0, ops: valid, errors };
}

function addDays(...groups) {
  return normalizeDays(groups.flatMap((group) => asArray(group)));
}

function addIds(...groups) {
  return normalizeIds(groups.flatMap((group) => asArray(group)));
}

/**
 * 把（通常已经 validate 过的）ops 落到 memory-space。
 *
 * 只通过 space 的接口写库，不直接访问文件系统。每一步都写 audit（如果 space 支持），
 * 单条失败只进入 skipped，不阻断后续条目。
 *
 * @param {object} space memory-space（需要 get/add/update/softDelete）
 * @param {Array<object>} ops 归一化后的 op 列表
 * @param {{day?: string, now?: number}} [options]
 * @returns {{applied: Array<object>, skipped: Array<object>}}
 */
export function applyConsolidateOps(space, ops, { day = '', now = Date.now() } = {}) {
  if (!space || typeof space.add !== 'function' || typeof space.update !== 'function' || typeof space.softDelete !== 'function') {
    throw new Error('applyConsolidateOps 需要 memory space（add/update/softDelete）');
  }

  const logicalDay = normalizeDay(day) || String(day ?? '').trim();
  const applied = [];
  const skipped = [];

  function audit(record) {
    try { space.audit?.(logicalDay || 'consolidation', record); } catch { /* 审计失败不影响记忆写入 */ }
  }

  function readExisting(id) {
    if (!id || typeof space.get !== 'function') return null;
    try { return space.get(id); } catch { return null; }
  }

  for (const raw of asArray(ops)) {
    try {
      // 落库前再归一化一次，保证直接调用 apply 也不丢 id / tier 继承规则。
      const rawId = String(raw?.id ?? '').trim();
      const rawIds = asArray(raw?.ids).map((value) => String(value ?? '').trim()).filter(Boolean);
      const localById = new Map();
      for (const id of [rawId, ...rawIds]) {
        if (!id || localById.has(id)) continue;
        const row = readExisting(id);
        if (row) localById.set(id, row);
      }
      const normalized = normalizeRawOp(raw, { existingById: localById, day: logicalDay });
      if (normalized.error) {
        skipped.push({ op: String(raw?.op ?? ''), id: rawId, reason: normalized.error });
        continue;
      }
      const op = normalized.op;

      if (op.op === 'add') {
        if (!op.text) {
          skipped.push({ op: op.op, id: '', reason: 'missing-text' });
          continue;
        }
        const item = space.add({
          space: op.space,
          kind: op.kind,
          tier: op.tier,
          status: 'active',
          text: op.text,
          tags: op.tags,
          importance: op.tier === 'core' ? 5 : op.importance,
          sourceDays: normalizeDays(op.sourceDays, logicalDay),
          sourceEventIds: op.sourceEventIds,
          confidence: op.confidence,
          by: 'consolidator',
          meta: {
            source: 'consolidate',
            consolidatedDay: logicalDay,
            reason: op.reason,
          },
        });
        applied.push({ op: 'add', id: item?.id ?? '' });
        audit({ op: 'add', id: item?.id ?? '', tier: item?.tier ?? op.tier, text: clip(item?.text ?? op.text, 160), reason: op.reason });
        continue;
      }

      if (op.op === 'update') {
        const current = readExisting(op.id);
        if (!current || current.deletedAt) {
          skipped.push({ op: op.op, id: op.id, reason: 'not-found' });
          continue;
        }
        const patch = {
          space: op.space || current.space,
          kind: op.kind || current.kind,
          tier: op.tier,
          importance: op.tier === 'core' ? 5 : op.importance,
          confidence: op.confidence,
          sourceDays: addDays(current.sourceDays, op.sourceDays, logicalDay),
          sourceEventIds: addIds(current.sourceEventIds, op.sourceEventIds),
          by: 'consolidator',
          meta: {
            ...(current.meta || {}),
            consolidatedDay: logicalDay,
            consolidatedAt: now,
            reason: op.reason,
          },
        };
        if (op.text) patch.text = op.text;
        if (op.tags.length) patch.tags = op.tags;
        const item = space.update(op.id, patch);
        if (!item) {
          skipped.push({ op: op.op, id: op.id, reason: 'not-found' });
          continue;
        }
        applied.push({ op: 'update', id: item.id });
        audit({ op: 'update', id: item.id, tier: item.tier, text: clip(item.text, 160), reason: op.reason });
        continue;
      }

      if (op.op === 'merge') {
        if (op.ids.length < 2 || !op.text) {
          skipped.push({ op: op.op, id: op.ids[0] || '', reason: op.text ? 'need-two-ids' : 'missing-text' });
          continue;
        }
        const rows = op.ids.map((id) => readExisting(id));
        const missing = op.ids.filter((id, index) => !rows[index] || rows[index].deletedAt);
        if (missing.length) {
          skipped.push({ op: op.op, id: op.ids[0], reason: `not-found: ${missing.join(', ')}` });
          continue;
        }
        const [target, ...rest] = rows;
        const targetId = target.id;
        const nextTier = op.tier || target.tier || 'active';
        const item = space.update(targetId, {
          space: op.space || target.space,
          kind: op.kind || target.kind,
          tier: nextTier,
          text: op.text,
          tags: normalizeTags([...(target.tags || []), ...rest.flatMap((row) => row.tags || []), ...op.tags]),
          importance: nextTier === 'core' ? 5 : (op.importance || target.importance || 3),
          confidence: op.confidence,
          sourceDays: addDays(target.sourceDays, ...rest.map((row) => row.sourceDays), op.sourceDays, logicalDay),
          sourceEventIds: addIds(target.sourceEventIds, ...rest.map((row) => row.sourceEventIds), op.sourceEventIds),
          by: 'consolidator',
          meta: {
            ...(target.meta || {}),
            consolidatedDay: logicalDay,
            consolidatedAt: now,
            reason: op.reason,
            mergedFrom: op.ids.slice(1),
          },
        });
        if (!item) {
          skipped.push({ op: op.op, id: targetId, reason: 'not-found' });
          continue;
        }
        const merged = [];
        for (const row of rest) {
          const removed = space.softDelete(row.id, 'consolidator');
          if (removed) merged.push(row.id);
        }
        applied.push({ op: 'merge', id: targetId, merged });
        audit({ op: 'merge', id: targetId, merged, text: clip(item.text, 160), reason: op.reason });
        continue;
      }

      if (op.op === 'forget') {
        const current = readExisting(op.id);
        if (!current || current.deletedAt) {
          skipped.push({ op: op.op, id: op.id, reason: 'not-found' });
          continue;
        }
        if (current.tier === 'core' && op.ownerRequested !== true) {
          skipped.push({ op: op.op, id: op.id, reason: 'core-requires-owner-request' });
          continue;
        }
        const item = space.softDelete(op.id, 'consolidator');
        if (!item) {
          skipped.push({ op: op.op, id: op.id, reason: 'not-found' });
          continue;
        }
        applied.push({ op: 'forget', id: op.id });
        audit({ op: 'forget', id: op.id, tier: current.tier, reason: op.reason });
        continue;
      }

      if (op.op === 'pin' || op.op === 'unpin') {
        const current = readExisting(op.id);
        if (!current || current.deletedAt) {
          skipped.push({ op: op.op, id: op.id, reason: 'not-found' });
          continue;
        }
        const nextTier = op.op === 'pin' ? 'core' : 'active';
        const item = space.update(op.id, {
          tier: nextTier,
          importance: nextTier === 'core' ? 5 : (op.importance || 3),
          confidence: op.confidence || current.confidence || 0.5,
          sourceDays: addDays(current.sourceDays, op.sourceDays, logicalDay),
          sourceEventIds: addIds(current.sourceEventIds, op.sourceEventIds),
          by: 'consolidator',
          meta: {
            ...(current.meta || {}),
            consolidatedDay: logicalDay,
            consolidatedAt: now,
            reason: op.reason,
            ...(nextTier === 'core' ? { pinnedAt: now } : { unpinnedAt: now }),
          },
        });
        if (!item) {
          skipped.push({ op: op.op, id: op.id, reason: 'not-found' });
          continue;
        }
        applied.push({ op: op.op, id: op.id });
        audit({ op: op.op, id: op.id, tier: item.tier, reason: op.reason });
        continue;
      }

      if (op.op === 'supersede') {
        const current = readExisting(op.id);
        if (!current || current.deletedAt) {
          skipped.push({ op: op.op, id: op.id, reason: 'not-found' });
          continue;
        }
        if (!op.text) {
          skipped.push({ op: op.op, id: op.id, reason: 'missing-text' });
          continue;
        }
        const nextTier = op.tier || current.tier;
        const patch = {
          text: op.text,
          tier: nextTier,
          kind: op.kind || current.kind,
          space: op.space || current.space,
          importance: nextTier === 'core' ? 5 : (op.importance || current.importance || 3),
          confidence: op.confidence || current.confidence,
          sourceDays: addDays(current.sourceDays, op.sourceDays, logicalDay),
          sourceEventIds: addIds(current.sourceEventIds, op.sourceEventIds),
          status: 'active',
          by: 'consolidator',
          meta: {
            ...(current.meta || {}),
            consolidatedDay: logicalDay,
            consolidatedAt: now,
            reason: op.reason,
            // 旧正文不丢：新事实覆盖正文，旧事实留在 meta 里可追溯。
            supersededText: current.text,
            supersededAt: now,
            supersededDay: logicalDay,
          },
        };
        if (op.tags.length) patch.tags = op.tags;
        const item = space.update(op.id, patch);
        if (!item) {
          skipped.push({ op: op.op, id: op.id, reason: 'not-found' });
          continue;
        }
        applied.push({ op: 'supersede', id: op.id });
        audit({
          op: 'supersede',
          id: op.id,
          tier: item.tier,
          text: clip(item.text, 160),
          supersededText: clip(current.text, 160),
          reason: op.reason,
        });
        continue;
      }

      skipped.push({ op: op.op, id: op.id || '', reason: 'unsupported-op' });
    } catch (error) {
      skipped.push({
        op: String(raw?.op ?? ''),
        id: String(raw?.id ?? ''),
        reason: String(error?.message ?? error).slice(0, 160),
      });
    }
  }

  return { applied, skipped };
}
