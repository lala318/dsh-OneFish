#!/usr/bin/env node
/**
 * 设置页客户端冒烟：不装 DSH、不装 React，只验证
 *   1. client.js 能被 DSH 的 loader 形态加载；
 *   2. apply() 会往 settings.section 注入；
 *   3. 首屏（数据还没回来）能渲染出树，不抛异常。
 *
 * 用的是一个极小的 React 替身：createElement 造普通对象，useState/useCallback/useEffect 够用即可。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let dispatcher = null;
const hookStates = [];
let hookIndex = 0;

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
  useState(initial) {
    assert.ok(dispatcher, 'useState 只能在渲染期调用');
    const index = hookIndex;
    hookIndex += 1;
    if (!(index in hookStates)) hookStates[index] = typeof initial === 'function' ? initial() : initial;
    return [hookStates[index], (next) => { hookStates[index] = typeof next === 'function' ? next(hookStates[index]) : next; }];
  },
  useCallback(fn) { return fn; },
  useEffect() {},
};

let loaded = null;
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      loaded = { id, exports: factory((name) => {
        assert.equal(name, 'react', `只应 require('react')，实际是 ${name}`);
        return fakeReact;
      }) };
    },
  },
};

await import(pathToFileURL(path.join(import.meta.dirname, '..', 'lib', 'client.js')).href);

assert.ok(loaded, 'client.js 应调用 __ModuleLoader__.load');
assert.equal(loaded.id, 'onefish-core');

const { exports } = loaded;
assert.equal(typeof exports.apply, 'function');
assert.equal(typeof exports.OneFishCoreSection, 'function');

const injected = [];
const registers = [];
const ctx = {
  effect(fn) { const dispose = fn(); assert.equal(typeof dispose, 'function'); },
  slots: {
    inject(name, fn) { injected.push(name); return fn(); },
    register(meta, component) { registers.push({ meta, component }); return () => {}; },
  },
};

exports.apply(ctx);
assert.deepEqual(injected, ['settings.section']);
assert.equal(registers.length, 1);
assert.equal(registers[0].meta.name, 'settings.section');
assert.equal(registers[0].meta.id, 'onefish-core');
assert.equal(registers[0].component, exports.OneFishCoreSection);
assert.equal(registers[0].meta.label(), 'OneFish');

// 首屏渲染：所有数据都是 null，应该走到「加载中…」而不是崩。
dispatcher = fakeReact;
hookIndex = 0;
let tree;
try {
  tree = exports.OneFishCoreSection();
} finally {
  dispatcher = null;
}
assert.ok(tree && tree.props && tree.props.style, '首屏应返回一个容器元素');
assert.ok(Array.isArray(tree.children) && tree.children.length > 0, '首屏应该有内容');

console.log('✅ 设置页客户端冒烟通过（loader / 注入 / 首屏渲染）');
