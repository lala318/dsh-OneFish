/**
 * 本地 embedding 服务（bge-small-zh-v1.5，ONNX CPU 推理）。
 *
 * 目的：给记忆检索提供语义向量，替代「关键词扫描 + 时间排序」。
 * 设计约束：
 *   · 零外部 API、断网可用（模型与 onnxruntime 都在 ~/.dsh/onefish/runtime 下）；
 *   · 加载失败不影响主流程：调用方拿不到 ready 就回退关键词检索；
 *   · 不把 onnxruntime 装进仓库依赖，而是用独立目录 + createRequire 解析，
 *     避免污染 OneFish 的 package.json / pnpm-lock。
 *
 * 模型目录结构（scripts/fetch-embedding-model.mjs 会下好）：
 *   <modelDir>/model.onnx
 *   <modelDir>/vocab.txt
 *   <modelDir>/tokenizer_config.json
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const DSH_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || os.homedir(), '.dsh');

export const DEFAULT_RUNTIME_DIR = path.join(DSH_HOME, 'cache', 'onefish', 'runtime', 'onnx-embed');
export const DEFAULT_MODEL_DIR = path.join(DEFAULT_RUNTIME_DIR, 'model');
export const DEFAULT_DIM = 512;
const MAX_LEN = 512;
const MODEL_NAME = 'bge-small-zh-v1.5';

function readJsonSafe(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** BERT WordPiece 分词（bge-zh 用的就是它）：CJK 逐字、英文按词、标点单独成 token。 */
function createTokenizer(vocabFile, { doLowerCase = true } = {}) {
  const vocab = new Map();
  const lines = fs.readFileSync(vocabFile, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const token = lines[i];
    if (token === '') continue;
    if (!vocab.has(token)) vocab.set(token, i);
  }
  const CLS = vocab.get('[CLS]') ?? 101;
  const SEP = vocab.get('[SEP]') ?? 102;
  const UNK = vocab.get('[UNK]') ?? 100;

  const isCjk = (cp) => (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)
    || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x3000 && cp <= 0x303f);
  const isPunct = (ch) => /[\u0021-\u002f\u003a-\u0040\u005b-\u0060\u007b-\u007e\uff00-\uff0f\uff1a-\uff20]/.test(ch);

  function basicTokenize(text) {
    const src = doLowerCase ? String(text ?? '').toLowerCase() : String(text ?? '');
    const out = [];
    let buf = '';
    const flush = () => { if (buf) { out.push(buf); buf = ''; } };
    for (const ch of src) {
      if (/\s/.test(ch)) { flush(); continue; }
      const cp = ch.codePointAt(0);
      if (isCjk(cp) || isPunct(ch)) { flush(); out.push(ch); continue; }
      buf += ch;
    }
    flush();
    return out;
  }

  function wordPiece(token) {
    if (token.length > 100) return [UNK];
    const pieces = [];
    let start = 0;
    let candidate = '';
    while (start < token.length) {
      let end = token.length;
      let found = null;
      while (start < end) {
        const sub = candidate ? `##${token.slice(start, end)}` : token.slice(start, end);
        if (vocab.has(sub)) { found = sub; break; }
        end -= 1;
      }
      if (!found) return [UNK];
      pieces.push(found);
      start = end;
      candidate = '##';
    }
    return pieces;
  }

  return {
    encode(text, maxLen = MAX_LEN) {
      const ids = [CLS];
      for (const token of basicTokenize(text)) {
        for (const piece of wordPiece(token)) {
          if (ids.length >= maxLen - 1) break;
          ids.push(vocab.get(piece) ?? UNK);
        }
        if (ids.length >= maxLen - 1) break;
      }
      ids.push(SEP);
      const mask = new Array(ids.length).fill(1);
      return { ids, mask };
    },
    vocabSize: vocab.size,
  };
}

function l2normalize(vec) {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < vec.length; i += 1) vec[i] /= norm;
  return vec;
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 创建 embedding 服务。失败时返回 { ready:false, error }，不抛。
 * @param {object} opts
 * @param {string} [opts.runtimeDir] onnxruntime-node 所在目录（默认 ~/.dsh/onefish/runtime/onnx-embed）
 * @param {string} [opts.modelDir]   模型目录
 * @param {(msg:string)=>void} [opts.log]
 */
export async function createEmbeddingService({ runtimeDir = DEFAULT_RUNTIME_DIR, modelDir = DEFAULT_MODEL_DIR, log = () => {} } = {}) {
  try {
    const modelPath = path.join(modelDir, 'model.onnx');
    const vocabPath = path.join(modelDir, 'vocab.txt');
    if (!fs.existsSync(modelPath) || !fs.existsSync(vocabPath)) {
      return { ready: false, error: `embedding 模型缺失：${modelPath}`, dim: DEFAULT_DIM };
    }
    const tokCfg = readJsonSafe(path.join(modelDir, 'tokenizer_config.json'), {}) || {};
    const doLowerCase = tokCfg.do_lower_case !== false;
    const tokenizer = createTokenizer(vocabPath, { doLowerCase });

    const requireFromRuntime = createRequire(path.join(runtimeDir, 'package.json'));
    const ort = requireFromRuntime('onnxruntime-node');
    const session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] });
    const inputNames = session.inputNames || [];
    const outputName = (session.outputNames || [])[0];
    let dim = DEFAULT_DIM;

    const cache = new Map();
    const CACHE_MAX = 500;

    async function embedOne(text) {
      const key = String(text ?? '').slice(0, 400);
      const hit = cache.get(key);
      if (hit) return hit;
      const { ids, mask } = tokenizer.encode(text);
      const feeds = {};
      const len = ids.length;
      if (inputNames.includes('input_ids')) feeds.input_ids = new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, len]);
      if (inputNames.includes('attention_mask')) feeds.attention_mask = new ort.Tensor('int64', BigInt64Array.from(mask.map(BigInt)), [1, len]);
      if (inputNames.includes('token_type_ids')) feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(len), [1, len]);
      const out = await session.run(feeds);
      const tensor = out[outputName] || out[Object.keys(out)[0]];
      const [, seqLen, hidden] = tensor.dims;
      dim = hidden;
      const data = tensor.data;
      const pooled = new Float32Array(hidden);
      let count = 0;
      for (let t = 0; t < seqLen; t += 1) {
        if (!mask[t]) continue;
        count += 1;
        const off = t * hidden;
        for (let h = 0; h < hidden; h += 1) pooled[h] += data[off + h];
      }
      if (count) for (let h = 0; h < hidden; h += 1) pooled[h] /= count;
      const vec = l2normalize(Array.from(pooled));
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(key, vec);
      return vec;
    }

    log(`embedding 就绪：${MODEL_NAME}（vocab=${tokenizer.vocabSize}）`);
    return {
      ready: true,
      dim,
      modelName: MODEL_NAME,
      async embed(texts) {
        const list = Array.isArray(texts) ? texts : [texts];
        const out = [];
        for (const t of list) out.push(await embedOne(t));
        return out;
      },
      async embedOne(text) { return embedOne(text); },
    };
  } catch (error) {
    return { ready: false, error: String(error?.message ?? error), dim: DEFAULT_DIM };
  }
}

/** Float32 向量 <-> base64（记忆索引落盘用，比 JSON 数组省 ~4 倍空间）。 */
export function encodeVector(vec) {
  return Buffer.from(new Float32Array(vec).buffer).toString('base64');
}

export function decodeVector(b64) {
  const buf = Buffer.from(String(b64), 'base64');
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}
