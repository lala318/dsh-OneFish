#!/usr/bin/env node
/**
 * MCP server 冒烟：stdio 起进程 → initialize → tools/list。
 * 不需要真实凭据（只列工具，不调工具）。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, '..', 'lib', 'mcp.mjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'onefish-bili-mcp-'));
process.on('exit', () => {
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
});

function rpcSession() {
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      // 隔离家目录：不让它读到真实 surfcore 凭据
      USERPROFILE: temp,
      HOME: temp,
      ONEFISH_COMPONENT_STATE_DIR: temp,
      ONEFISH_COMPONENT_CONFIG_FILE: path.join(temp, 'config.json'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });
  function request(id, method, params) {
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 15_000);
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  function notify(method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }
  return { child, request, notify };
}

test('MCP tools/list：12 个 bili_* 工具都在', async () => {
  const session = rpcSession();
  try {
    const init = await session.request(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'onefish-test', version: '0.0.1' },
    });
    assert.equal(init.result?.serverInfo?.name, 'onefish-bili');
    session.notify('notifications/initialized', {});
    const list = await session.request(2, 'tools/list', {});
    const names = (list.result?.tools ?? []).map((tool) => tool.name).sort();
    const expected = [
      'bili_comment_inbox',
      'bili_comment_list',
      'bili_comment_reply',
      'bili_comment_thread',
      'bili_dm_messages',
      'bili_dm_send',
      'bili_dm_sessions',
      'bili_status',
      'bili_video_comments',
      'bili_video_frames',
      'bili_video_info',
      'bili_video_subtitles',
    ].sort();
    assert.deepEqual(names, expected);
  } finally {
    session.child.kill();
  }
});

test('无凭据时 bili_status 明确失败（不假装成功）', async () => {
  const session = rpcSession();
  try {
    await session.request(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'onefish-test', version: '0.0.1' },
    });
    session.notify('notifications/initialized', {});
    const result = await session.request(3, 'tools/call', { name: 'bili_status', arguments: {} });
    const payload = JSON.parse(result.result?.content?.[0]?.text ?? '{}');
    assert.equal(payload.ok, false);
    assert.equal(payload.credentials?.usable, false);
  } finally {
    session.child.kill();
  }
});
