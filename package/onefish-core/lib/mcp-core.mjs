#!/usr/bin/env node
/**
 * OneFish Core MCP server（stdio）。
 *
 * 只暴露核心工具：人格、记忆、会话。
 * 不依赖 DSH 插件宿主，直接通过 @onefish/core 读写同一份数据。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createCore } from './core/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const core = createCore({ repoRoot });

const server = new McpServer({ name: 'onefish-core', version: '0.1.0' });

function text(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function fail(error) {
  return { content: [{ type: 'text', text: String(error?.message ?? error) }], isError: true };
}

server.tool(
  'persona_get',
  '读取当前人格卡（角色名、正文、来源）。每轮新会话或怀疑人格切换时先调用它，再按人格卡说话。',
  {},
  async () => {
    try {
      const persona = core.persona.get();
      return text({
        name: persona.name,
        source: persona.source,
        text: persona.text,
      });
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'memory_search',
  '检索 OneFish 长期记忆（core / active / knowledge）。日常优先用它，不要一次拉全库。',
  {
    query: z.string().optional().describe('检索词；为空时返回最重要的最近记忆'),
    tier: z.enum(['', 'core', 'active', 'knowledge']).optional().describe('限定层级'),
    k: z.number().int().min(1).max(30).optional().describe('返回条数，默认 8'),
  },
  async ({ query, tier, k }) => {
    try { return text(core.memory.search(query || '', { tier: tier || '', k: k || 8 })); }
    catch (error) { return fail(error); }
  }
);

server.tool(
  'memory_add',
  '写入一条长期记忆。core 只放身份/边界/长期承诺；active 放偏好/近况/项目事实；knowledge 放黑话/梗/表情。',
  {
    text: z.string().min(1).describe('记忆正文，一句话说清'),
    tier: z.enum(['core', 'active', 'knowledge']).optional().describe('默认 active'),
    kind: z.enum(['fact', 'preference', 'relation', 'commitment', 'open_loop', 'slang', 'meme', 'sticker', 'other']).optional(),
    tags: z.array(z.string()).max(8).optional(),
    importance: z.number().int().min(1).max(5).optional(),
  },
  async ({ text: body, tier, kind, tags, importance }) => {
    try {
      return text(core.memory.add({ text: body, tier, kind, tags, importance, by: 'agent' }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'memory_update',
  '按 id 更新一条记忆（文字/层级/类型/标签/重要性）。',
  {
    id: z.string().describe('记忆 id'),
    text: z.string().optional(),
    tier: z.enum(['core', 'active', 'knowledge']).optional(),
    kind: z.enum(['fact', 'preference', 'relation', 'commitment', 'open_loop', 'slang', 'meme', 'sticker', 'other']).optional(),
    tags: z.array(z.string()).max(8).optional(),
    importance: z.number().int().min(1).max(5).optional(),
  },
  async ({ id, ...patch }) => {
    try {
      const result = core.memory.update(id, patch);
      return result ? text(result) : { content: [{ type: 'text', text: `没有找到记忆：${id}` }], isError: true };
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'memory_delete',
  '软删除一条记忆（设置页可恢复）。',
  { id: z.string().describe('记忆 id') },
  async ({ id }) => {
    try {
      const result = core.memory.remove(id);
      return result ? text(result) : { content: [{ type: 'text', text: `没有找到记忆：${id}` }], isError: true };
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'memory_list',
  '列出记忆（可按层级/关键词过滤），用于定位 id 或检查当前记忆面。',
  {
    tier: z.enum(['', 'core', 'active', 'knowledge']).optional(),
    q: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  },
  async ({ tier, q, limit }) => {
    try { return text(core.memory.list({ tier: tier || '', q: q || '', limit: limit || 30 })); }
    catch (error) { return fail(error); }
  }
);

server.tool(
  'memory_archive_search',
  '检索全量档案（按天归档的会话原文）；与 memory_search 的 memory-space 检索不同，建议只在有必要时使用。',
  {
    query: z.string().min(1),
    limit: z.number().int().min(1).max(50).optional(),
  },
  async ({ query, limit }) => {
    try { return text(core.archive.search(query, { limit: limit || 8 })); }
    catch (error) { return fail(error); }
  }
);

server.tool(
  'session_get',
  '查看日会话状态（今日 sessionId、封存/整理状态；消息历史在 DSH，不在此工具里）。',
  {},
  async () => {
    try {
      const status = core.session.status();
      return text({
        current: status.active,
        stats: status.stats,
        recent: status.recent,
      });
    } catch (error) {
      return fail(error);
    }
  }
);

await server.connect(new StdioServerTransport());
