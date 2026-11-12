#!/usr/bin/env node
/**
 * OneFish Core MCP server 端到端回归：起 stdio server，列工具，调 persona_get / memory_add / memory_search。
 * 运行：node onefish-core/test/mcp.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'onefish-core-mcp-'));

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

try {
  const character = path.join(temp, 'characters', 'c1');
  write(path.join(temp, 'characters', 'current.json'), JSON.stringify({ version: 1, id: 'c1', name: 'MCP 测试' }));
  write(path.join(character, 'character.json'), JSON.stringify({ name: 'MCP 测试' }));
  write(path.join(character, 'persona.md'), '# MCP 测试\n\n你是 MCP 测试人格。\n');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'onefish-core/lib/mcp-core.mjs')],
    env: { ...process.env, ONEFISH_CORE_HOME: temp },
    stderr: 'inherit',
  });
  const client = new Client({ name: 'onefish-core-test', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    const list = await client.listTools();
    const names = list.tools.map((tool) => tool.name);
    for (const name of ['persona_get', 'memory_search', 'memory_add', 'memory_update', 'memory_delete', 'memory_list', 'session_get']) {
      assert.ok(names.includes(name), `应注册工具：${name}`);
    }

    const persona = await client.callTool({ name: 'persona_get', arguments: {} });
    assert.match(String(persona.content?.[0]?.text || ''), /MCP 测试人格/);

    const added = await client.callTool({
      name: 'memory_add',
      arguments: { text: 'MCP 写入的记忆', tier: 'active', kind: 'fact', tags: ['test'] },
    });
    assert.match(String(added.content?.[0]?.text || ''), /MCP 写入的记忆/);

    const searched = await client.callTool({ name: 'memory_search', arguments: { query: 'MCP', k: 5 } });
    assert.match(String(searched.content?.[0]?.text || ''), /MCP 写入的记忆/);

    const sessions = await client.callTool({ name: 'session_get', arguments: {} });
    assert.match(String(sessions.content?.[0]?.text || ''), /stats/);
    console.log('✅ OneFish Core MCP 测试通过');
  } finally {
    await client.close().catch(() => {});
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
