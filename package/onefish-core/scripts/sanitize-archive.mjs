#!/usr/bin/env node
/**
 * 归档脱敏迁移：扫描 archive/days 与 archive/digests，把 token/secret 替换为 [redacted]。
 *
 *   node scripts/sanitize-archive.mjs [--home <onefish-core-home>] [--apply]
 *
 * 默认 dry-run；--apply 会先备份到 archive/redaction-backup-<时间戳>/。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactSecrets, hasSecret } from '../lib/core/domain/redaction.js';

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : '';
}

function walk(dir, suffix, out = []) {
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const item of names) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) walk(full, suffix, out);
    else if (item.isFile() && item.name.endsWith(suffix)) out.push(full);
  }
  return out;
}

function sanitizeJsonValue(value) {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(sanitizeJsonValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = sanitizeJsonValue(item);
    return out;
  }
  return value;
}

function sanitizeJsonl(text, file) {
  let changed = 0;
  const lines = text.split(/\r?\n/);
  const out = lines.map((line) => {
    if (!line.trim()) return line;
    try {
      const parsed = JSON.parse(line);
      const next = sanitizeJsonValue(parsed);
      const body = JSON.stringify(next);
      if (body !== line) changed += 1;
      return body;
    } catch {
      if (hasSecret(line)) {
        changed += 1;
        return redactSecrets(line);
      }
      return line;
    }
  });
  return { text: out.join('\n'), changed };
}

function sanitizeMarkdown(text) {
  const next = redactSecrets(text);
  return { text: next, changed: next !== text ? 1 : 0 };
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const home = path.resolve(argValue(args, '--home') || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'onefish'));
const daysDir = path.join(home, 'archive', 'days');
const digestsDir = path.join(home, 'archive', 'digests');

const dayFiles = walk(daysDir, '.jsonl');
const digestFiles = walk(digestsDir, '.md');
const changes = [];

for (const file of dayFiles) {
  const before = fs.readFileSync(file, 'utf8');
  const result = sanitizeJsonl(before, file);
  if (result.changed > 0) changes.push({ file, changed: result.changed, text: result.text });
}
for (const file of digestFiles) {
  const before = fs.readFileSync(file, 'utf8');
  const result = sanitizeMarkdown(before);
  if (result.changed > 0) changes.push({ file, changed: result.changed, text: result.text });
}

console.log(`home=${home}`);
console.log(`files=${dayFiles.length + digestFiles.length} changedFiles=${changes.length}`);
for (const item of changes) console.log(`  ${path.relative(home, item.file)} (${item.changed})`);

if (!apply) {
  console.log('dry-run；加 --apply 才会写入。');
  process.exit(0);
}
if (changes.length === 0) {
  console.log('没有需要写入的变更。');
  process.exit(0);
}

for (const item of changes) writeAtomic(item.file, item.text);
console.log(`已写入 ${changes.length} 个文件；未保留含 secret 的备份。`);
