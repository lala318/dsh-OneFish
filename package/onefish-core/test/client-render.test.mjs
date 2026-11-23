#!/usr/bin/env node
/**
 * 设置页「有数据」渲染回归：把八个页签各渲染一次，确保真实数据形状下不抛异常。
 *
 * 做法：用一个极小的 React 替身，按 useState 的声明顺序注入假数据，
 * 然后切换 tab 值再渲染。这不能替代浏览器验收，但能挡住「某个页签一进就白屏」这类错误。
 *
 * ⚠️ 如果 client.js 里 useState 的顺序/数量变了，这里的 SENTINEL 顺序要同步改。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let seed = [];
let hookIndex = 0;
let inRender = false;

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
  useState(initial) {
    assert.ok(inRender, 'useState 只能在渲染期调用');
    const index = hookIndex;
    hookIndex += 1;
    if (index in seed) return [seed[index], () => {}];
    return [typeof initial === 'function' ? initial() : initial, () => {}];
  },
  useCallback(fn) { return fn; },
  useEffect() {},
};

let loaded = null;
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      loaded = { id, exports: factory(() => fakeReact) };
    },
  },
};

await import(pathToFileURL(path.join(import.meta.dirname, '..', 'lib', 'client.js')).href);
const { OneFishCoreSection } = loaded.exports;

const overview = {
  home: "C:/data",
  persona: { name: "测试角色", chars: 42, configured: true, preview: "# 测试" },
  session: { currentDay: "2026-11-24", workspaceTitle: "onefish", active: { sessionId: "s-1", bootPackAt: 1 } },
  memory: { total: 3, core: 1, active: 1, knowledge: 1 },
  archive: { days: 5 },
  components: [{ id: "bili", name: "B站", version: "0.1.0", status: "running", error: "", capabilities: ["dm", "comment"] }],
};

const persona = { name: "测试角色", source: "characters/c1/persona.md", text: "# 测试角色\n" };
const characters = { current: "c1", items: [{ id: "c1", name: "测试角色" }, { id: "c2", name: "备用" }] };
const memories = [
  { id: "m1", tier: "core", kind: "commit", text: "一条核心记忆", importance: 5 },
  { id: "m2", tier: "active", kind: "fact", text: "一条普通记忆", importance: 3 },
];
const config = {
  rolloverHour: 4,
  preset: "onefish-core",
  titlePrefix: "OneFish",
  workspaceTitle: "onefish",
  workspacePath: "C:/ws",
  bootMaxChars: 5000,
  personaMaxChars: 2000,
  digestMaxChars: 1200,
  historyPageMessages: 200,
  historyMaxPages: 50,
  autoConsolidate: true,
  consolidateOnBootstrap: true,
  timestamp: { enabled: true },
  recall: { enabled: true, topK: 3, minScore: 0.6, lexicalMinScore: 0.35, minRelevance: 0.4, timeoutMs: 600, maxChars: 600, minQueryChars: 6, maxQueryChars: 800, skipFirstTurn: true, skipPrefixes: ["【空闲】"] },
  embedding: { runtimeDir: "", modelDir: "" },
  idleClock: { enabled: false, checkIntervalMs: 300000, minIdleMs: 600000, scaleHours: 3, shape: 2, cooldownMinMs: 2700000, cooldownMaxMs: 5400000 },
};
const idle = { enabled: false, active: true, idleMs: 15 * 60000, firedToday: 0, config: config.idleClock };
const sessions = {
  active: { sessionId: "s-1", bootPackAt: 1 },
  recent: [{ day: "2026-11-24", sessionId: "s-1", state: "active", archivePath: "x", consolidatedAt: 0 }],
  stats: { currentDay: "2026-11-24", workspaceTitle: "onefish", pending: 0 },
};
const diagnostics = {
  version: "0.1.0",
  node: "v26.13.0",
  platform: "win32 x64",
  home: "C:/data",
  configFile: "C:/data/config.json",
  checks: [
    { id: "node", title: "Node 运行时", status: "pass", detail: "v26.13.0", hint: "" },
    { id: "embedding", title: "向量检索", status: "warn", detail: "未就绪", hint: "装模型" },
    { id: "sessionAdapter", title: "DSH 会话适配器", status: "fail", detail: "不可用", hint: "重启 DSH" },
  ],
  summary: { pass: 1, warn: 1, fail: 1 },
};

// 与 client.js 里 useState 的声明顺序一一对应。
function seedFor(tabName) {
  return {
    0: tabName,        // tab
    1: "",             // busy
    2: "",             // error
    3: "",             // notice
    4: [],             // warnings
    5: overview,       // overview
    6: diagnostics,    // diagnostics
    7: persona,        // persona
    8: persona.text,   // personaDraft
    9: characters,     // characters
    10: "",            // newCharId
    11: "",            // newCharName
    12: memories,      // memories
    13: overview.memory, // memoryStats
    14: "",            // memoryQuery
    15: "",            // memoryTier
    16: "",            // newText
    17: "active",      // newTier
    18: config,        // config
    19: config,        // configDraft
    20: "C:/data/config.json", // configFile
    21: idle,          // idle
    22: "",            // idlePreview
    23: sessions,      // sessions
    24: "",            // bootPreview
    25: "",            // consolidateDay
    26: [],            // bootstrapActions
  };
}

function renderTab(tabName) {
  seed = seedFor(tabName);
  hookIndex = 0;
  inRender = true;
  try {
    return OneFishCoreSection();
  } finally {
    inRender = false;
  }
}

function flattenText(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const child of node) flattenText(child, out); return out; }
  if (typeof node.type === "function") {
    // 自定组件（Row / Section / Field / Empty）：像 React 那样展开，children 走 props。
    const children = node.children.length === 1 ? node.children[0] : node.children;
    flattenText(node.type({ ...node.props, children }), out);
    return out;
  }
  if (node.children) flattenText(node.children, out);
  return out;
}

const tabs = [
  ["overview", "概览"],
  ["persona", "人格"],
  ["memory", "记忆"],
  ["config", "配置"],
  ["idle", "空闲钟"],
  ["session", "会话"],
  ["components", "组件"],
  ["diag", "自检"],
];

for (const [id, label] of tabs) {
  const tree = renderTab(id);
  assert.ok(tree, `${label}：应返回元素`);
  const text = flattenText(tree).join(" ");
  assert.ok(text.length > 0, `${label}：应有文字内容`);
  assert.ok(text.includes("OneFish"), `${label}：应包含页面标题`);
  console.log(`✔ ${label} 页签渲染通过（${text.length} 字）`);
}

// 有数据时不该再显示「加载中…」
const overviewTree = flattenText(renderTab("overview")).join(" ");
assert.ok(!overviewTree.includes("加载中"), "数据已就绪时不应显示加载中");
assert.ok(overviewTree.includes("测试角色"), "概览应显示人格名");
assert.ok(overviewTree.includes("B站"), "概览应列出组件");

const diagText = flattenText(renderTab("diag")).join(" ");
assert.ok(diagText.includes("DSH 会话适配器"), "自检应列出会话适配器");
assert.ok(diagText.includes("不可用"), "自检应显示失败详情");

const cfgText = flattenText(renderTab("config")).join(" ");
assert.ok(cfgText.includes("每轮记忆召回"), "配置页应有召回小节");
assert.ok(cfgText.includes("向量模型"), "配置页应有向量模型小节");

const memoryText = flattenText(renderTab("memory")).join(" ");
assert.ok(memoryText.includes("一条核心记忆"), "记忆页应列出条目");

console.log("✅ 设置页有数据渲染回归通过（8 个页签）");
