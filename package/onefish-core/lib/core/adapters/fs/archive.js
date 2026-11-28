/**
 * 全量档案：每天一份 JSONL + 一份 Markdown 摘要。
 *
 * 档案是 append-only 的“历史事实来源”；memory-space 是另一层可召回记忆。
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildDigest, normalizeRecords, sourceHash } from '../../domain/consolidation.js';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeAtomic(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function readText(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return text;
  } catch {
    return '';
  }
}

export function createArchiveService({ paths, logger = () => {} }) {
  function dayFile(day, suffix = '') {
    return path.join(paths.archiveDaysDir, `${day}${suffix}.jsonl`);
  }

  function digestFile(day, suffix = '') {
    return path.join(paths.archiveDigestsDir, `${day}${suffix}.md`);
  }

  /**
   * 写入一天的全量档案。
   *
   * - 同一天同内容：返回已有路径，不重复写；
   * - 同一天不同内容：写一个带 hash 的 revision，不覆盖旧档案。
   */
  function consolidateDay({ day, sessionId = '', records = [] }) {
    const messages = normalizeRecords(records);
    if (!messages.length) {
      const archivePath = dayFile(day);
      const digestPath = digestsFor(day, '');
      writeAtomic(archivePath, '');
      writeAtomic(digestPath, `# OneFish ${day}\n\n- 无消息\n`);
      return {
        day,
        count: 0,
        sourceHash: sourceHash([]),
        archivePath,
        digestPath,
        skipped: false,
      };
    }
    const hash = sourceHash(messages);
    const body = `${messages.map((m) => JSON.stringify({ day, sessionId, ...m })).join('\n')}\n`;
    const base = dayFile(day);
    let archivePath = base;
    let revision = '';
    const existing = readText(base);
    if (existing) {
      if (existing === body) {
        return {
          day,
          count: messages.length,
          sourceHash: hash,
          archivePath: base,
          digestPath: digestsFor(day, ''),
          skipped: true,
        };
      }
      revision = `-${hash.slice(0, 8)}`;
      archivePath = dayFile(day, revision);
    }
    writeAtomic(archivePath, body);
    const digestPath = digestsFor(day, revision);
    writeAtomic(digestPath, `${buildDigest({ day, sessionId, messages, sourceHash: hash })}\n`);
    logger(`档案已写入：${day}（${messages.length} 条消息）`);
    return {
      day,
      count: messages.length,
      sourceHash: hash,
      archivePath,
      digestPath,
      revision: revision || 'base',
      skipped: false,
    };
  }

  function digestsFor(day, suffix) {
    return digestFile(day, suffix);
  }

  function readDigest(day) {
    const base = readText(digestFile(day));
    if (base) return base;
    try {
      const revisions = fs.readdirSync(paths.archiveDigestsDir)
        .filter((name) => name.startsWith(`${day}-`) && name.endsWith('.md'))
        .sort()
        .reverse();
      return revisions[0] ? readText(path.join(paths.archiveDigestsDir, revisions[0])) : '';
    } catch {
      return '';
    }
  }

  function summaryFile(day) {
    return path.join(paths.archiveDigestsDir, `${day}.summary.md`);
  }

  /** 模型压缩出来的当日要点；第一行记下源哈希，方便判断要不要重做。 */
  function writeSummary(day, { text = '', sourceHash: hash = '' } = {}) {
    writeAtomic(summaryFile(day), `<!-- source:${hash} -->\n${String(text).trim()}\n`);
  }

  function readSummary(day) {
    const raw = readText(summaryFile(day));
    if (!raw.trim()) return null;
    const match = raw.match(/^<!-- source:(\S*) -->\r?\n?/);
    const body = (match ? raw.slice(match[0].length) : raw).trim();
    if (!body) return null;
    return { text: body, sourceHash: match ? match[1] : '' };
  }

  /** 读取某天已归档的原始记录；供模型夜间整理使用。 */
  function readDay(day) {
    return readText(dayFile(day)).split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  }

  function listDays() {
    try {
      return fs.readdirSync(paths.archiveDaysDir)
        .filter((name) => /^\d{4}-\d{2}-\d{2}.*\.jsonl$/.test(name))
        .map((name) => name.slice(0, 10))
        .filter((day, index, all) => all.indexOf(day) === index)
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  /** 全量档案的简单文本检索；不替代 memory-space 的语义召回。 */
  function search(query, { limit = 8 } = {}) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const max = Math.max(1, Math.min(50, Number(limit) || 8));
    const out = [];
    const seen = new Set();
    for (const day of listDays()) {
      let names = [];
      try {
        names = fs.readdirSync(paths.archiveDaysDir)
          .filter((name) => name.startsWith(`${day}`) && name.endsWith('.jsonl'));
      } catch { continue; }
      for (const name of names) {
        const file = path.join(paths.archiveDaysDir, name);
        const lines = readText(file).split(/\r?\n/).filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          let entry;
          try { entry = JSON.parse(lines[i]); } catch { continue; }
          const text = String(entry?.text || '');
          if (!text.toLowerCase().includes(q)) continue;
          const key = `${day}:${entry.seq}:${text}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            day,
            sessionId: String(entry.sessionId || ''),
            seq: Number(entry.seq || 0),
            role: String(entry.role || ''),
            text,
          });
          if (out.length >= max) return out;
        }
      }
    }
    return out;
  }

  return { consolidateDay, readDigest, readDay, readSummary, writeSummary, listDays, search };
}
