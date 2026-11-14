#!/usr/bin/env node
/**
 * DSH session 历史脱敏迁移。
 *
 *   node scripts/sanitize-dsh-sessions.mjs [--apply] [--include-active]
 *
 * 默认 dry-run，跳过当前 active 日会话。--apply 会先写临时文件，重新解压校验
 * 后再替换原文件；不会保留含 secret 的备份。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { redactSecrets } from '../lib/core/domain/redaction.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const includeActive = args.includes('--include-active');
const dshHome = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
const sessionsRoot = path.join(dshHome, 'sessions');
const indexPath = path.join(dshHome, 'onefish-core', 'core', 'session-index.json');

function readJson(file, fallback = null) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

const activeSessionId = String(readJson(indexPath, {})?.active?.sessionId || '');

function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && /^session\.v4\.jsonl\.zstd(\.|$)/.test(entry.name)) out.push(full);
  }
  return out;
}

function redactValue(value) {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = redactValue(item);
    return out;
  }
  return value;
}

function redactLine(line) {
  if (!line.trim()) return line;
  try {
    return JSON.stringify(redactValue(JSON.parse(line)));
  } catch {
    return redactSecrets(line);
  }
}

function rebuild(files) {
  const lines = files.toString('utf8').split(/\r?\n/).filter((line) => line.trim());
  const changed = lines.map(redactLine);
  const changedCount = changed.reduce((count, line, index) => count + (line !== lines[index] ? 1 : 0), 0);
  if (!changedCount) return { changedCount: 0, buffer: files };
  const frames = changed.map((line) => zlib.zstdCompressSync(Buffer.from(`${line}\n`, 'utf8')));
  return { changedCount, buffer: Buffer.concat(frames) };
}

const files = walk(sessionsRoot);
const changes = [];
for (const file of files) {
  const name = path.basename(file);
  const sessionId = path.basename(path.dirname(file));
  if (!includeActive && sessionId === activeSessionId && name === 'session.v4.jsonl.zstd') continue;
  let decompressed;
  try {
    decompressed = zlib.zstdDecompressSync(fs.readFileSync(file));
  } catch (error) {
    console.log(`SKIP ${file} (not zstd: ${error.message})`);
    continue;
  }
  const result = rebuild(decompressed);
  if (result.changedCount > 0) changes.push({ file, sessionId, changedCount: result.changedCount, buffer: result.buffer });
}

console.log(`sessionsRoot=${sessionsRoot}`);
console.log(`active=${activeSessionId || '(none)'} files=${files.length} changedFiles=${changes.length}`);
for (const item of changes) console.log(`  ${item.sessionId}/${path.basename(item.file)} (${item.changedCount})`);

if (!apply) {
  console.log('dry-run；加 --apply 才会写入。');
  process.exit(0);
}
if (changes.length === 0) {
  console.log('没有需要写入的变更。');
  process.exit(0);
}

for (const item of changes) {
  const tmp = `${item.file}.redact-${process.pid}.tmp`;
  fs.writeFileSync(tmp, item.buffer);
  const check = zlib.zstdDecompressSync(fs.readFileSync(tmp)).toString('utf8');
  const checkLines = check.split(/\r?\n/).filter((line) => line.trim());
  if (checkLines.some((line) => redactLine(line) !== line)) {
    try { fs.unlinkSync(tmp); } catch {}
    throw new Error(`redaction verification failed: ${item.file}`);
  }
  fs.renameSync(tmp, item.file);
}
console.log(`已写入 ${changes.length} 个 session 文件；未保留含 secret 的备份。`);
