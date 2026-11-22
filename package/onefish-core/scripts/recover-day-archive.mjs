#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
function fail(message) { console.error(message); process.exit(2); }
if (args.length < 2) fail("usage: node recover-day-archive.mjs <sessionId> <day> [outPath] [--sessions-dir DIR]");
const sessionId = args[0];
const day = args[1];
let outPath = "";
let sessionsDir = "";
for (let i = 2; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--sessions-dir") { sessionsDir = args[i + 1] || ""; i += 1; }
  else if (!outPath) outPath = arg;
  else fail("unexpected argument: " + arg);
}
if (!sessionsDir) {
  const cwd = process.cwd();
  const mangled = "--" + cwd.replace(/^([A-Za-z]):/, "$1").replace(/[\\/]/g, "-") + "--";
  sessionsDir = join(homedir(), ".dsh", "sessions", mangled);
}
const file = join(sessionsDir, sessionId, "session.v4.jsonl.zstd");
let raw;
try {
  raw = readFileSync(file);
} catch (error) { fail("cannot read " + file + ": " + error.message); }
const text = zstdDecompressSync(raw).toString("utf8");
const events = text.split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
const rows = [];
let skippedEmpty = 0;
for (const event of events) {
  if (event.type !== "user/message" && event.type !== "assistant/message") continue;
  const data = event.data || {};
  const message = data.message || data;
  const parts = Array.isArray(message.content) ? message.content : [];
  const body = parts.filter((part) => part && part.type === "text").map((part) => part.text || "").join("\n");
  if (!body.trim()) { skippedEmpty += 1; continue; }
  rows.push({ day, sessionId, seq: event.seq, type: event.type, role: message.role, text: body, at: event.time });
}
const target = outPath || day + ".day-archive.jsonl";
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
console.log("events=" + events.length + " messages=" + rows.length + " skippedEmpty=" + skippedEmpty + " -> " + target);
