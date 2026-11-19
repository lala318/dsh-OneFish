#!/usr/bin/env node
/**
 * B站组件 MCP server（stdio）。
 *
 * 只暴露「看视频 / 私信 / 评论」这一组：
 *   - bili_status            只读诊断（账号、凭据、未读、配置）
 *   - bili_dm_sessions       私信会话列表
 *   - bili_dm_messages       某个会话的历史消息
 *   - bili_dm_send           发私信（主人不限；别人只能回，见 dm.js 规则）
 *   - bili_comment_inbox     评论收件箱（回复我的 / @我的）
 *   - bili_comment_thread    回读某个评论楼（拿对方到底说了什么）
 *   - bili_comment_list      评论区 / 动态评论列表
 *   - bili_comment_reply     发评论 / 二级回复
 *   - bili_video_info        视频信息（标题/简介/UP/数据）
 *   - bili_video_subtitles   字幕全文
 *   - bili_video_comments    视频热评
 *   - bili_video_frames      下载并抽帧九宫格（配 read_image 看）
 *
 * 安全边界：
 *   - 凭据只从 ONEFISH_COMPONENT_STATE_DIR / 旧 surfcore 路径读取，不打印、不进 prompt；
 *   - 所有写操作都走 dm.js / comments.js 里的长度与对象校验；
 *   - 失败一律明确报错，不假装成功。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import { loadConfig, resolveStateDir, publicConfigSummary } from './config.js';
import { loadCredentials, credentialsStatus } from './credentials.js';
import { createBiliClient } from './http.js';
import { createDmApi } from './dm.js';
import { createCommentApi } from './comments.js';
import { createVideoApi } from './video.js';

const stateDir = resolveStateDir();
const configFile = loadConfig({ stateDir }).configFile;
let cachedConfig = loadConfig({ stateDir }).config;
let configMtime = 0;

function currentConfig() {
  try {
    const mtime = fs.statSync(configFile).mtimeMs;
    if (mtime !== configMtime) {
      configMtime = mtime;
      cachedConfig = loadConfig({ stateDir }).config;
    }
  } catch {}
  return cachedConfig;
}

function loadClient() {
  const config = currentConfig();
  const cred = loadCredentials({ config, stateDir });
  if (!cred) {
    throw new Error('B站凭据不可用：没有找到 sessdata / bili_jct / buvid3（检查 config.credentialsFile 或旧 surfcore 凭据文件）');
  }
  return { client: createBiliClient(cred), config, cred };
}

function apis() {
  const { client, config, cred } = loadClient();
  return {
    client,
    config,
    cred,
    dm: createDmApi(client, { config }),
    comments: createCommentApi(client),
    video: createVideoApi(client, { config }),
  };
}

function text(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function fail(error) {
  return { content: [{ type: 'text', text: `失败：${String(error?.message ?? error)}` }], isError: true };
}

function clampText(value, limit = 240) {
  const raw = String(value ?? '').replace(/\s+/g, ' ').trim();
  return raw.length > limit ? `${raw.slice(0, limit - 1)}…` : raw;
}

function clock(ts) {
  const n = Number(ts) || 0;
  if (!n) return '';
  const d = new Date(n * 1000);
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const server = new McpServer({ name: 'onefish-bili', version: '0.1.0' });

server.tool(
  'bili_status',
  '查看 B站组件状态（只读）：凭据是否可用、登录账号、私信未读数、配置摘要。不返回 cookie。',
  {},
  async () => {
    try {
      const config = currentConfig();
      const status = credentialsStatus({ config, stateDir });
      const out = {
        ok: status.usable,
        stateDir,
        credentials: {
          usable: status.usable,
          source: status.source ? '(file)' : '',
          self: status.self ? { mid: status.self.mid, name: status.self.name } : null,
        },
        config: publicConfigSummary(config),
      };
      if (status.usable) {
        try {
          const { client } = loadClient();
          const nav = await client.nav();
          out.login = {
            isLogin: nav?.data?.isLogin === true,
            uname: String(nav?.data?.uname ?? ''),
            mid: String(nav?.data?.mid ?? ''),
          };
          const json = await client.getJson('https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions?session_type=1&group_id=0&count=50&mobi_app=web', { referer: 'https://message.bilibili.com/' });
          const list = json?.data?.session_list ?? [];
          out.dm = {
            sessions: list.length,
            unreadSessions: list.filter((s) => Number(s?.unread_count ?? 0) > 0).length,
            unreadTotal: list.reduce((sum, s) => sum + (Number(s?.unread_count ?? 0) || 0), 0),
          };
        } catch (error) {
          out.probeError = String(error?.message ?? error);
        }
      }
      return text(out);
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'bili_dm_sessions',
  'B站私信会话列表（只读）：谁找过我、最后一句、未读数、时间。',
  {
    count: z.number().int().min(1).max(100).optional().describe('最多返回几个会话，默认 50'),
  },
  async ({ count }) => {
    try {
      const { dm } = apis();
      const sessions = await dm.sessions({ count: count || 50 });
      return text({
        count: sessions.length,
        sessions: sessions.map((s) => ({
          mid: s.mid,
          name: s.name,
          unread: s.unread,
          lastText: clampText(s.lastText, 200),
          lastAt: clock(s.ts),
          lastFromSelf: s.lastFromSelf,
          system: s.system,
        })),
      });
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'bili_dm_messages',
  '拉某个 B站私信会话的历史消息（只读，按时间正序）。',
  {
    mid: z.string().describe('对方的 mid（B站用户 id）'),
    size: z.number().int().min(1).max(50).optional().describe('最多几条，默认 20'),
  },
  async ({ mid, size }) => {
    try {
      const { dm } = apis();
      const messages = await dm.messages({ mid, size: size || 20 });
      return text({
        mid: String(mid),
        count: messages.length,
        messages: messages.map((m) => ({ fromSelf: m.senderIsSelf, at: clock(m.ts), text: clampText(m.text, 500) })),
      });
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'bili_dm_send',
  '给 B站 发一条私信。规则：主人（config.owner.mid）不限；发给别人只能回——对方必须是这个会话最后说话的人、48 小时内，且组件允许陌生人回复。发前想清楚，发失败会明确报错，不要声称已发送。',
  {
    mid: z.string().describe('收信人 mid'),
    text: z.string().min(1).describe('私信正文（纯文本，默认上限 300 字）'),
  },
  async ({ mid, text: body }) => {
    try {
      const { dm } = apis();
      const result = await dm.send({ mid, text: body });
      return text({ ok: true, ...result });
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'bili_comment_inbox',
  'B站评论收件箱（只读）：回复我的 / @我的。每一条会尽量回读楼层拿对方真正说的话（title 不可靠）。',
  {
    kind: z.enum(['reply', 'at', 'both']).optional().describe('收件箱类型，默认 both'),
    pages: z.number().int().min(1).max(5).optional().describe('翻几页，默认 1'),
    resolve: z.boolean().optional().describe('是否回读楼层拿正文，默认 true'),
    limit: z.number().int().min(1).max(30).optional().describe('最多返回几条，默认 10'),
  },
  async ({ kind, pages, resolve, limit }) => {
    try {
      const { comments } = apis();
      const kinds = kind === 'both' || !kind ? ['reply', 'at'] : [kind];
      const max = limit || 10;
      const items = [];
      for (const k of kinds) {
        const result = await comments.pullInbox(k, { pages: pages || 1 });
        for (const item of result.items) items.push(item);
      }
      items.sort((a, b) => Number(b.t || 0) - Number(a.t || 0));
      const picked = items.slice(0, max);
      const out = [];
      for (const item of picked) {
        const entry = {
          kind: item.kind,
          at: clock(item.t),
          who: item.who,
          mid: item.mid,
          oid: item.oid,
          root: item.root,
          parent: item.parent,
          business: item.business,
          text: clampText(item.source || item.title, 300),
        };
        if (resolve !== false && item.oid && item.root && item.mid) {
          try {
            const resolved = await comments.resolveLatestReply({
              business: item.business,
              oid: item.oid,
              root: item.root,
              mid: item.mid,
              parentRpid: item.parent,
            });
            if (resolved && (resolved.exact || !entry.text)) {
              entry.resolvedText = clampText(resolved.text, 300);
              entry.resolvedExact = resolved.exact === true;
            }
          } catch {}
        }
        out.push(entry);
      }
      return text({ count: out.length, unreadHint: '用 bili_comment_reply 回复；oid/root 见每条', items: out });
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'bili_comment_thread',
  '回读某个评论楼的全部回复（只读）：给 oid + root，可选 type（11/17 动态，1 视频）。',
  {
    oid: z.string().describe('评论区对象 id（视频是 aid，动态是动态 id）'),
    root: z.string().describe('根评论 rpid'),
    type: z.number().int().optional().describe('评论区类型：1 视频（默认），11/17 动态'),
  },
  async ({ oid, root, type }) => {
    try {
      const { comments } = apis();
      const replies = [];
      for (let pn = 1; pn <= 6; pn += 1) {
        const url = `https://api.bilibili.com/x/v2/reply/reply?type=${Number(type) || 1}&oid=${encodeURIComponent(oid)}&root=${encodeURIComponent(root)}&ps=20&pn=${pn}`;
        const { client } = apis();
        const json = await client.getJson(url);
        const page = json?.data?.replies ?? [];
        replies.push(...page);
        if (page.length < 20) break;
      }
      return text({
        oid: String(oid),
        root: String(root),
        count: replies.length,
        replies: replies.map((r) => ({
          rpid: String(r?.rpid ?? ''),
          mid: String(r?.mid ?? ''),
          uname: String(r?.member?.uname ?? ''),
          parent: String(r?.parent ?? ''),
          at: clock(r?.ctime),
          like: Number(r?.like ?? 0),
          text: clampText(r?.content?.message, 500),
        })),
      });
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'bili_comment_list',
  '读评论区（只读）：给 bvid 或 oid。sort=2 热度、0 时间。',
  {
    bvid: z.string().optional().describe('视频 BV 号（给了就自动取 aid）'),
    oid: z.string().optional().describe('评论区对象 id（视频 aid / 动态 id）'),
    type: z.number().int().optional().describe('类型：1 视频（默认），11/17 动态'),
    pn: z.number().int().min(1).optional().describe('页码，默认 1'),
    ps: z.number().int().min(1).max(30).optional().describe('每页条数，默认 20'),
    sort: z.number().int().optional().describe('2=热度（默认），0=时间'),
  },
  async ({ bvid, oid, type, pn, ps, sort }) => {
    try {
      const { comments, video } = apis();
      let targetOid = oid ? String(oid) : '';
      let targetType = Number(type) || 1;
      let aid = targetOid;
      let cid = '';
      if (bvid) {
        const info = await video.info({ bvid });
        aid = String(info.aid);
        cid = String(info.cid || '');
        targetOid = aid;
        targetType = 1;
      }
      if (!targetOid) throw new Error('需要 bvid 或 oid');
      const page = await comments.list({ oid: targetOid, type: targetType, pn: pn || 1, ps: ps || 20, sort: sort ?? 2 });
      return text({ bvid: bvid || '', aid, cid, type: targetType, ...page });
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'bili_comment_reply',
  '发一条 B站 评论或二级回复。视频评论给 oid=aid（或先用 bili_video_info 换 aid），动态给 oid=动态 id、type=11/17。root=根评论 rpid，parent=要回复的那条 rpid。写操作，可能触发风控；失败会明确报错。',
  {
    oid: z.string().describe('评论区对象 id（视频 aid / 动态 id）'),
    type: z.number().int().optional().describe('1=视频（默认），11/17=动态'),
    message: z.string().min(1).describe('评论正文（默认上限 300 字）'),
    root: z.string().optional().describe('根评论 rpid；直接评论视频/动态时不传'),
    parent: z.string().optional().describe('要回复的那条 rpid；直接评论时不传'),
  },
  async ({ oid, type, message, root, parent }) => {
    try {
      const { comments, config } = apis();
      const maxLength = Number(config?.outbound?.maxCommentLength) || 300;
      if (String(message).length > maxLength) throw new Error(`评论太长（${String(message).length} > ${maxLength}）`);
      const result = await comments.post({
        oid: String(oid),
        type: Number(type) || 1,
        message: String(message),
        root: root ? String(root) : '0',
        parent: parent ? String(parent) : '0',
      });
      return text({ ok: true, ...result });
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'bili_video_info',
  '视频信息（只读）：标题、简介、UP、时长、数据、aid/cid。',
  {
    bvid: z.string().describe('BV 号，例如 BV1xx411c7mD'),
  },
  async ({ bvid }) => {
    try {
      const { video } = apis();
      return text(await video.info({ bvid }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'bili_video_subtitles',
  '拉视频字幕全文（只读，优先中文；有 AI 字幕就用 AI 字幕）。',
  {
    bvid: z.string().describe('BV 号'),
  },
  async ({ bvid }) => {
    try {
      const { video } = apis();
      return text(await video.subtitles({ bvid }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'bili_video_comments',
  '视频热评（只读）：默认按热度，带二级回复摘要。',
  {
    bvid: z.string().describe('BV 号'),
    ps: z.number().int().min(1).max(30).optional().describe('每页条数，默认 20'),
    pn: z.number().int().min(1).optional().describe('页码，默认 1'),
  },
  async ({ bvid, ps, pn }) => {
    try {
      const { video } = apis();
      return text(await video.comments({ bvid, pn: pn || 1, ps: ps || 20, sort: 2 }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'bili_video_frames',
  '看视频：下载直链并按数量抽帧，拼成九宫格图片，返回图片绝对路径（再用 read_image 看）。会落盘到临时目录。',
  {
    bvid: z.string().describe('BV 号'),
    count: z.number().int().min(1).max(16).optional().describe('抽几帧，默认 9'),
  },
  async ({ bvid, count }) => {
    try {
      const { video } = apis();
      const result = await video.frames({ bvid, count: count || 9 });
      return text({
        bvid,
        title: result.title,
        duration: result.duration,
        grid: result.grid,
        images: result.images,
        hint: '用 read_image 打开 grid 或单帧；要字幕用 bili_video_subtitles。',
      });
    } catch (error) {
      return fail(error);
    }
  }
);

await server.connect(new StdioServerTransport());
