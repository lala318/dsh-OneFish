/**
 * Embedding 服务选择器：
 *   - 优先加载 bge-small-zh-v1.5 ONNX；
 *   - 模型/onnxruntime 不可用时回退到本地 hash 向量；
 *   - 对外只暴露 async embedOne，索引层不关心具体模型。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { embedText, HASH_DIM } from '../../domain/vector.js';
import { createEmbeddingService } from './onnx.js';

const DSH_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || os.homedir(), '.dsh');

function firstRuntime(runtimeDir = '') {
  const explicit = String(runtimeDir || process.env.ONEFISH_EMBED_RUNTIME || '').trim();
  const candidates = [
    explicit,
    path.join(DSH_HOME, 'cache', 'onefish', 'runtime', 'onnx-embed'),
    // 旧位置，只作兼容：2026-11-22 之前 runtime 在数据根里
    path.join(DSH_HOME, 'onefish-core', 'runtime', 'onnx-embed'),
    path.join(DSH_HOME, 'surfcore', 'runtime', 'onnx-embed'),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'model', 'model.onnx'))) return dir;
    } catch {}
  }
  return explicit || path.join(DSH_HOME, 'cache', 'onefish', 'runtime', 'onnx-embed');
}

export function createEmbeddingProvider({ runtimeDir = '', modelDir = '', logger = () => {} } = {}) {
  const runtime = firstRuntime(runtimeDir);
  const model = String(modelDir || '').trim() || path.join(runtime, 'model');
  let servicePromise = null;
  let service = null;
  let fallback = false;

  async function ensure() {
    if (service) return service;
    if (!servicePromise) {
      servicePromise = createEmbeddingService({
        runtimeDir: runtime,
        modelDir: model,
        log: (...args) => logger('[embedding]', ...args),
      }).then((loaded) => {
        service = loaded;
        fallback = !loaded?.ready;
        if (fallback) logger(`embedding 回退 hash：${loaded?.error || '未就绪'}`);
        return loaded;
      }).catch((error) => {
        service = { ready: false, error: String(error?.message ?? error), dim: HASH_DIM };
        fallback = true;
        logger(`embedding 回退 hash：${service.error}`);
        return service;
      });
    }
    return servicePromise;
  }

  async function embedOne(text) {
    const loaded = await ensure();
    if (loaded?.ready && typeof loaded.embedOne === 'function') {
      return loaded.embedOne(text);
    }
    return embedText(text, { dim: HASH_DIM });
  }

  function status() {
    const ready = service?.ready === true;
    return {
      ready,
      fallback,
      model: service?.modelName || (fallback ? 'local-hash-256' : ''),
      dim: ready ? (service?.dim || HASH_DIM) : HASH_DIM,
      error: service?.error || '',
      runtime,
      modelDir: model,
    };
  }

  return {
    embedOne,
    status,
    get ready() { return service?.ready === true; },
    get modelName() { return service?.modelName || (fallback ? 'local-hash-256' : 'unloaded'); },
    get dim() { return service?.dim || HASH_DIM; },
  };
}
