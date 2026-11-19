/**
 * B站组件（OneFish Component Contract v1）。
 *
 * 交付模式：tool
 *   - 入站：轮询私信会话 + 评论收件箱（回复我的 / @我的），有新东西才 submit 到日会话；
 *   - 出站：模型自己调本组件的 bili_* MCP 工具（lib/mcp.mjs）；
 *   - 不做「自动转发 assistant 文本」，避免和工具发送双发。
 *
 * 组件只通过 scoped handle 使用 Core：scope.session.submit / scope.stateDir / scope.config。
 * 不 import core 内部，不直接调 sessionController，不读 Core 私有配置。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { validateManifest, createInbound } from '@onefish/component-sdk';
import { createDefaultConfig, normalizeConfig, publicConfigSummary, readConfigFile, writeConfigFile, resolveConfigFile } from './config.js';
import { loadCredentials } from './credentials.js';
import { createBiliClient } from './http.js';
import { createDmApi } from './dm.js';
import { createCommentApi } from './comments.js';
import { createStateStore } from './state.js';

export const MANIFEST = validateManifest({
  manifestVersion: 1,
  id: 'bili',
  name: 'B站',
  version: '0.1.0',
  apiVersion: 1,
  core: '^0.1.0',
  capabilities: {
    channel: { inbound: true, outbound: 'tool' },
    tools: true,
    jobs: false,
    context: true,
  },
  state: true,
  configSchema: {
    credentialsFile: { type: 'string', description: '凭据文件路径；留空按 stateDir / 旧 surfcore 顺序找' },
    owner: { type: 'object', description: '主人 mid/称呼（决定私信权限）' },
    poll: { type: 'object', description: '轮询开关与间隔' },
    outbound: { type: 'object', description: '私信/评论长度与陌生人回复开关' },
    video: { type: 'object', description: 'ffmpeg 与抽帧设置' },
  },
});

function defaultLogger(...args) {
  try { console.log('[onefish-bili]', ...args); } catch {}
}

function shortText(value, limit = 200) {
  const raw = String(value ?? '').replace(/\s+/g, ' ').trim();
  return raw.length > limit ? `${raw.slice(0, limit - 1)}…` : raw;
}

function clock(ts) {
  const n = Number(ts) || 0;
  if (!n) return '';
  const d = new Date(n * 1000);
  const pad = (v) => String(v).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function createBiliComponent(options = {}) {
  const logger = typeof options.logger === 'function' ? options.logger : defaultLogger;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  let scope = null;
  let started = false;
  let generation = 0;
  let config = createDefaultConfig();
  let configFile = '';
  let configMtime = 0;
  let store = null;
  let client = null;
  let dmApi = null;
  let commentApi = null;
  let timer = null;
  let lastError = '';
  let lastActivityAt = 0;
  let lastPollAt = 0;
  let baselineDone = false;
  const seenInbound = new Set();
  const counters = { polls: 0, dmSubmitted: 0, commentSubmitted: 0, errors: 0, duplicates: 0, skipped: 0 };

  function noteError(error) {
    counters.errors += 1;
    lastError = String(error?.message ?? error);
    logger(lastError);
  }

  function refreshConfigFromFile() {
    if (!started || !configFile) return false;
    let mtime = 0;
    try { mtime = Number(fs.statSync(configFile).mtimeMs) || 0; } catch { return false; }
    if (mtime && mtime === configMtime) return false;
    const next = readConfigFile(configFile);
    if (!next) return false;
    configMtime = mtime;
    config = next;
    return true;
  }

  function buildApis() {
    const cred = loadCredentials({ config, stateDir: scope.stateDir });
    if (!cred) {
      client = null;
      dmApi = null;
      commentApi = null;
      return false;
    }
    const createClient = typeof options.createClient === 'function' ? options.createClient : createBiliClient;
    const createDm = typeof options.createDm === 'function' ? options.createDm : createDmApi;
    const createComments = typeof options.createComments === 'function' ? options.createComments : createCommentApi;
    client = createClient(cred, { logger });
    dmApi = createDm(client, { config, logger });
    commentApi = createComments(client, { logger });
    return true;
  }

  async function submit({ channelKey, messageId, text, user, meta }) {
    const envelope = createInbound({
      channelKey,
      requestId: randomUUID(),
      messageId,
      user: user || null,
      text,
      receivedAt: now(),
      meta,
    });
    const accepted = await scope.session.submit(envelope);
    lastActivityAt = now();
    logger(`入站 ${channelKey} chars=${text.length} session=${accepted?.sessionId || '?'}`);
    return accepted;
  }

  async function pollDm() {
    if (!dmApi) return;
    const sessions = await dmApi.sessions({ count: 50 });
    if (!baselineDone) {
      let marked = 0;
      for (const s of sessions) {
        if (store.setWatermark(`dm:${s.mid}`, s.ts)) marked += 1;
      }
      store.flush();
      logger(`基线：把 ${sessions.length} 个私信会话记为已读（${marked} 个有更新）`);
      return;
    }
    for (const s of sessions) {
      if (!s.mid || s.system || s.lastFromSelf) continue;
      const key = `dm:${s.mid}`;
      const watermark = store.getWatermark(key);
      if (Number(s.ts) <= watermark) continue;
      const dedupeKey = `dm:${s.mid}:${s.ts}`;
      if (store.isDuplicate(dedupeKey) || seenInbound.has(dedupeKey)) {
        counters.duplicates += 1;
        continue;
      }
      seenInbound.add(dedupeKey);
      const text = `【B站私信】${s.name || `mid ${s.mid}`} 说：${shortText(s.lastText, 500)}`;
      try {
        await submit({
          channelKey: key,
          messageId: dedupeKey,
          text,
          user: { id: s.mid, name: s.name || '' },
          meta: { wakeReason: 'dm', unread: s.unread, at: s.ts },
        });
        store.remember(dedupeKey);
        store.setWatermark(key, s.ts);
        counters.dmSubmitted += 1;
      } catch (error) {
        seenInbound.delete(dedupeKey);
        noteError(error);
      }
    }
  }

  async function pollComments() {
    if (!commentApi) return;
    const kinds = ['reply', 'at'];
    for (const kind of kinds) {
      let result;
      try {
        result = await commentApi.pullInbox(kind, { pages: 1 });
      } catch (error) {
        noteError(error);
        continue;
      }
      const items = result.items || [];
      const key = `comment:${kind}`;
      if (!baselineDone) {
        const newest = items.reduce((max, item) => Math.max(max, Number(item.t) || 0), 0);
        if (newest) store.setWatermark(key, newest);
        store.flush();
        continue;
      }
      const watermark = store.getWatermark(key);
      const fresh = items
        .filter((item) => Number(item.t) > watermark)
        .sort((a, b) => Number(a.t) - Number(b.t));
      if (!fresh.length) continue;
      for (const item of fresh.slice(0, 3)) {
        const dedupeKey = `comment:${kind}:${item.id}`;
        if (store.isDuplicate(dedupeKey) || seenInbound.has(dedupeKey)) {
          counters.duplicates += 1;
          continue;
        }
        seenInbound.add(dedupeKey);
        let spoken = String(item.source || item.title || '').trim();
        let resolved = null;
        if (item.oid && item.root && item.mid) {
          try {
            resolved = await commentApi.resolveLatestReply({
              business: item.business,
              oid: item.oid,
              root: item.root,
              mid: item.mid,
              parentRpid: item.parent,
            });
            if (resolved?.text && (resolved.exact === true || !spoken)) spoken = resolved.text;
          } catch (error) {
            logger(`回读楼层失败（用收件箱正文兜底）：${error?.message ?? error}`);
          }
        }
        const text = `【B站评论】${item.who || `mid ${item.mid}`} ${kind === 'at' ? '@了你' : '回复了你'}：${shortText(spoken, 500)}`;
        try {
          await submit({
            channelKey: `comment:${item.oid || item.id}`,
            messageId: dedupeKey,
            text,
            user: { id: item.mid, name: item.who || '' },
            meta: {
              wakeReason: kind === 'at' ? 'at' : 'comment',
              oid: item.oid,
              root: item.root,
              parent: resolved?.rpid || item.parent,
              business: item.business,
              at: item.t,
            },
          });
          store.remember(dedupeKey);
          counters.commentSubmitted += 1;
        } catch (error) {
          seenInbound.delete(dedupeKey);
          noteError(error);
        }
      }
      const newest = fresh.reduce((max, item) => Math.max(max, Number(item.t) || 0), watermark);
      store.setWatermark(key, newest);
    }
  }

  async function tick(gen) {
    if (!started || gen !== generation) return;
    refreshConfigFromFile();
    if (!config.poll.enabled) return;
    if (!client && !buildApis()) return;
    counters.polls += 1;
    lastPollAt = now();
    try {
      if (config.poll.dm) await pollDm();
      if (config.poll.comment) await pollComments();
      if (!baselineDone && store) {
        store.setFlag('initialized');
        store.flush();
        baselineDone = true;
        logger('基线完成：之后只提交水位之后的新消息');
      }
    } catch (error) {
      noteError(error);
    }
  }

  const component = {
    manifest: MANIFEST,

    async start(nextScope) {
      if (started) return;
      if (!nextScope || typeof nextScope !== 'object') throw new Error('bili component requires a scoped handle');
      if (!nextScope.session || typeof nextScope.session.submit !== 'function') {
        throw new Error('bili component requires scope.session.submit');
      }
      scope = nextScope;
      started = true;
      generation += 1;
      baselineDone = false;
      lastError = '';
      for (const key of Object.keys(counters)) counters[key] = 0;
      seenInbound.clear();

      configFile = resolveConfigFile(scope.stateDir);
      try {
        const fileConfig = readConfigFile(configFile);
        config = fileConfig || normalizeConfig(scope.config || {});
        if (!fileConfig) writeConfigFile(configFile, config);
        configMtime = Number(fs.statSync(configFile).mtimeMs) || 0;
      } catch (error) {
        config = normalizeConfig(scope.config || {});
        configMtime = 0;
        noteError(error);
      }

      try {
        store = createStateStore({ dir: scope.stateDir, limit: config.dedupeWindow, logger });
        // 只有第一次装组件时把现状当基线；之后重启都接着水位继续，离线期间的新消息不丢。
        baselineDone = store.getFlag('initialized');
      } catch (error) {
        store = null;
        baselineDone = false;
        noteError(error);
      }

      buildApis();
      const intervalMs = Math.max(30, Number(config.poll.intervalSec) || 120) * 1000;
      const gen = generation;
      timer = setInterval(() => { void tick(gen); }, intervalMs);
      // 启动后先跑一轮；没有凭据时只记一次错，不阻塞 Core。
      void tick(gen);
    },

    async stop() {
      if (!started) return;
      started = false;
      generation += 1;
      if (timer) clearInterval(timer);
      timer = null;
      try { store?.close?.(); } catch (error) { noteError(error); }
      store = null;
      client = null;
      dmApi = null;
      commentApi = null;
      scope = null;
    },

    async health() {
      const cred = started ? loadCredentials({ config, stateDir: scope?.stateDir }) : null;
      return {
        id: MANIFEST.id,
        status: !started ? 'stopped' : (lastError ? 'degraded' : 'running'),
        started,
        outbound: MANIFEST.capabilities.channel.outbound,
        hasCredentials: Boolean(cred),
        account: cred ? { mid: cred.mid || '', name: cred.name || '' } : null,
        lastPollAt,
        lastActivityAt,
        lastError,
        counters: { ...counters },
        baselineDone,
        polling: { enabled: config.poll.enabled, intervalSec: config.poll.intervalSec, dm: config.poll.dm, comment: config.poll.comment },
        config: publicConfigSummary(config),
        configFile,
      };
    },

    /** 立即跑一轮轮询（诊断/测试用；正常靠定时器）。 */
    async pollOnce() {
      return tick(generation);
    },

    renderPrompt(envelope) {
      refreshConfigFromFile();
      const channelKey = String(envelope?.channelKey || '');
      const [kind, ...rest] = channelKey.split(':');
      const target = rest.join(':');
      const when = clock(Number(envelope?.receivedAt) / 1000);
      const meta = envelope?.meta || {};
      const wake = meta.wakeReason || 'unknown';
      if (kind === 'dm') {
        const name = envelope?.user?.name || target;
        const header = [`B站私信`, when, `唤醒:${wake}`, name].filter(Boolean).join('｜');
        return [
          `【${header}】`,
          `发送：bili_dm_send(mid="${target}", text="...")；要上下文用 bili_dm_messages(mid="${target}")。`,
        ].join('\n');
      }
      const header = [`B站评论`, when, `唤醒:${wake}`, envelope?.user?.name || ''].filter(Boolean).join('｜');
      const parts = [`【${header}】`];
      if (meta.oid) {
        parts.push(`回复：bili_comment_reply(oid="${meta.oid}", type=${meta.business === 11 || meta.business === 17 ? meta.business : 1}, root="${meta.root || ''}", parent="${meta.parent || ''}", message="...")。`);
        parts.push(`楼里上下文：bili_comment_thread(oid="${meta.oid}", root="${meta.root || ''}", type=${meta.business === 11 || meta.business === 17 ? meta.business : 1})。`);
      } else {
        parts.push('回读上下文：bili_comment_inbox。');
      }
      return parts.join('\n');
    },
  };

  return component;
}

export const name = 'onefish-component-bili';
export const inject = ['onefishCore'];

export async function apply(ctx) {
  const handle = await ctx.onefishCore.components.register(createBiliComponent());
  return () => handle?.stop?.();
}

export default { name, inject, apply, MANIFEST, createBiliComponent };
