#!/usr/bin/env node
/**
 * 设置页写请求回归：没有 body 的 POST 也必须带 application/json。
 *
 * 背景：宿主对写接口要求 content-type 是 application/json，
 * 之前 api("/idle/run", { method: "POST" }) 没带 body，被 415 挡下来，
 * 点「立即想一次」直接报「写操作必须是 application/json」。
 */
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

let loaded = null;
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      loaded = { id, exports: factory(() => ({ createElement: () => null, useCallback: (fn) => fn, useEffect() {}, useState: () => [null, () => {}] })) };
    },
  },
};

await import(pathToFileURL(path.join(import.meta.dirname, "..", "lib", "client.js")).href);

const { __api: api } = loaded.exports;
assert.equal(typeof api, "function", "client 应暴露测试用的 api 钩子");

const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  return { ok: true, status: 200, json: async () => ({ ok: true }) };
};

// 无 body 的写操作：必须补空对象 + JSON 头
await api("/idle/run", { method: "POST" });
assert.equal(calls.length, 1);
assert.equal(calls[0].url, "/dsh-onefish-core/api/idle/run");
assert.equal(calls[0].init.method, "POST");
assert.equal(calls[0].init.headers["content-type"], "application/json");
assert.equal(calls[0].init.body, "{}");

// 带 body 的：原样发，不重复包一层
await api("/config", { method: "POST", body: JSON.stringify({ config: { rollupHour: 4 } }) });
assert.equal(calls[1].init.body, JSON.stringify({ config: { rollupHour: 4 } }));
assert.equal(calls[1].init.headers["content-type"], "application/json");

// GET：不该有 content-type / body
await api("/overview");
assert.equal(calls[2].init.method, "GET");
assert.equal(calls[2].init.headers["content-type"], undefined);
assert.equal(calls[2].init.body, undefined);

// 小写 method 也要认
await api("/session/ensure", { method: "post" });
assert.equal(calls[3].init.method, "POST");
assert.equal(calls[3].init.body, "{}");

// 服务端返回错误时抛出可读信息
globalThis.fetch = async () => ({ ok: false, status: 415, json: async () => ({ error: "写操作必须是 application/json" }) });
await assert.rejects(() => api("/idle/run", { method: "POST" }), /写操作必须是 application\/json/);

console.log("✅ 设置页写请求回归通过（空 body 补 JSON / GET 不带多余头 / 错误透传）");
