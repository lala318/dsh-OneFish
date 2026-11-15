/**
 * 本地轻量向量：字符 n-gram 哈希到固定维度，再 L2 归一化。
 *
 * 不依赖模型/网络；索引和余弦检索仍是标准向量路径。
 * 后续可注入 bge/ONNX embedding，替换 embedText 即可。
 */
export const HASH_DIM = 256;

function hash32(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function embedText(text, { dim = HASH_DIM } = {}) {
  const src = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 800);
  const vec = new Float32Array(dim);
  if (!src) return Array.from(vec);
  const grams = [];
  for (let i = 0; i < src.length; i += 1) {
    grams.push(src[i]);
    if (i + 1 < src.length) grams.push(src.slice(i, i + 2));
    if (i + 2 < src.length) grams.push(src.slice(i, i + 3));
  }
  for (const gram of grams) {
    const h = hash32(gram);
    const idx = h % dim;
    const sign = (h & 0x80000000) ? -1 : 1;
    vec[idx] += sign * (1 + Math.min(2, gram.length - 1));
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i += 1) vec[i] /= norm;
  return Array.from(vec);
}

export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
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

export function encodeVector(vec) {
  return Buffer.from(new Float32Array(vec).buffer).toString('base64');
}

export function decodeVector(value) {
  const buf = Buffer.from(String(value || ''), 'base64');
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)));
}

export function textHash(text) {
  return hash32(String(text || '')).toString(36);
}
