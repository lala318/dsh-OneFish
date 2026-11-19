#!/usr/bin/env node
/**
 * B站评论模块测试：收件箱 / 回读楼层 / 发评论 / 列表 / 删除。
 * 全部注入假 client（不走网络、不碰凭据），http 层另有测试。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommentApi } from '../lib/comments.js';

const API = {
  msgfeed: 'https://api.bilibili.com/x/msgfeed',
  add: 'https://api.bilibili.com/x/v2/reply/add',
  del: 'https://api.bilibili.com/x/v2/reply/del',
  list: 'https://api.bilibili.com/x/v2/reply',
  thread: 'https://api.bilibili.com/x/v2/reply/reply',
};

/** 假 client：只实现 comments.js 用到的三件事，并按调用顺序记账。 */
function fakeClient({ getJson, postForm, signedQuery } = {}) {
  const calls = [];
  const client = {
    calls,
    self: { mid: '700001', name: '测试号' },
    csrf: 'csrf-for-tests',
    headers: (referer = 'https://www.bilibili.com/') => ({ referer }),
    async getJson(url, options = {}) {
      calls.push({ kind: 'getJson', url, options });
      return getJson(url, options);
    },
    async postForm(url, fields, options = {}) {
      calls.push({ kind: 'postForm', url, fields, options });
      return postForm(url, fields, options);
    },
  };
  if (signedQuery) {
    client.signedQuery = async (params) => {
      calls.push({ kind: 'signedQuery', params });
      return signedQuery(params);
    };
  }
  return client;
}

const callsOf = (client, kind) => client.calls.filter((call) => call.kind === kind);

// 19 位动态 id 的写法本身就会被 JS 舍入 —— 这正是 JSON.parse 之后的样子
const UNSAFE_DYNAMIC_ID = 1261813571425140745;
const EXACT_DYNAMIC_ID = '1261813571425140745';

test('pullInbox：解析字段、从 uri 取 19 位 id（不丢精度）、翻页按 item.id 去重', async () => {
  assert.equal(Number.isSafeInteger(UNSAFE_DYNAMIC_ID), false, '这个 id 必须超出安全整数，否则测不到精度坑');

  const dynamicReply = {
    id: '9001',
    reply_time: 1700000100,
    user: { nickname: '阿黄', mid: 700001 },
    item: {
      uri: `https://t.bilibili.com/${EXACT_DYNAMIC_ID}#reply2291234567890`,
      title: '同一句标题（不可靠）',
      source_content: '来源摘要',
      target_reply_content: '被回的那条',
      business_id: 17,
      subject_id: UNSAFE_DYNAMIC_ID,
      root_id: 2291234567890,
      source_id: 2291234567899,
    },
  };
  const unsafeWithoutUri = {
    id: '9002',
    reply_time: 1700000200,
    user: { nickname: '路人', mid: 700002 },
    item: { title: '同一句标题（不可靠）', business_id: 3, subject_id: UNSAFE_DYNAMIC_ID },
  };
  const opusUri = {
    id: '9003',
    reply_time: 1700000300,
    user: { nickname: '小蓝', mid: 700003 },
    item: {
      uri: 'https://www.bilibili.com/opus/987654321098765',
      business_id: 11,
      subject_id: 12345,
      root_id: '111',
      source_id: 222,
    },
  };
  const safeWithoutUri = {
    id: '9004',
    reply_time: 1700000400,
    user: { nickname: '老白', mid: 700004 },
    item: { subject_id: 123456789 },
  };
  const noUser = {
    id: '9005',
    user: {},
    item: { uri: 'https://t.bilibili.com/1261813571425140001#reply2', business_id: 17 },
  };

  const pages = {
    '': { code: 0, data: { cursor: 'cursor-1', last_view_at: 1700000500, items: [dynamicReply, unsafeWithoutUri, opusUri] } },
    'cursor-1': { code: 0, data: { cursor: 'cursor-2', items: [dynamicReply, safeWithoutUri, noUser] } },
    'cursor-2': { code: 0, data: { cursor: '', items: [] } },
  };
  const client = fakeClient({
    async getJson(url) {
      const cursor = new URL(url).searchParams.get('cursor') ?? '';
      return pages[cursor];
    },
  });
  const api = createCommentApi(client);
  const result = await api.pullInbox('reply', { pages: 3 });

  assert.equal(result.lastView, 1700000500);
  assert.deepEqual(result.items.map((item) => item.id), ['9001', '9002', '9003', '9004', '9005']);
  assert.equal(result.items.filter((item) => item.id === '9001').length, 1, '翻页重叠的那条要去重');

  const byId = new Map(result.items.map((item) => [item.id, item]));
  const dyn = byId.get('9001');
  assert.equal(dyn.kind, 'reply');
  assert.equal(dyn.oid, EXACT_DYNAMIC_ID);
  assert.notEqual(dyn.oid, String(UNSAFE_DYNAMIC_ID), '不能把 JSON.parse 舍入后的 id 当 oid');
  assert.equal(dyn.root, '2291234567890');
  assert.equal(dyn.parent, '2291234567899');
  assert.equal(dyn.business, 17);
  assert.equal(dyn.who, '阿黄');
  assert.equal(dyn.mid, '700001');
  assert.equal(dyn.t, 1700000100);
  assert.equal(dyn.title, '同一句标题（不可靠）');
  assert.equal(dyn.source, '来源摘要');
  assert.equal(dyn.target, '被回的那条');
  assert.match(dyn.uri, /t\.bilibili\.com/);

  // 19 位动态 id 且没有 uri → 宁可没有 oid，也不要用截断值
  assert.equal(byId.get('9002').oid, '');
  assert.equal(byId.get('9002').business, 3);

  // opus 链接同样能取到 id；subject_id 不可靠时不参与
  assert.equal(byId.get('9003').oid, '987654321098765');
  assert.equal(byId.get('9003').root, '111');
  assert.equal(byId.get('9003').parent, '222');
  assert.equal(byId.get('9003').business, 11);

  // 没有 uri 时，安全整数范围内的 subject_id 可以用
  assert.equal(byId.get('9004').oid, '123456789');
  assert.equal(byId.get('9004').business, 1);

  // 缺字段的降级：昵称 '?'，时间 0
  assert.equal(byId.get('9005').who, '?');
  assert.equal(byId.get('9005').mid, '');
  assert.equal(byId.get('9005').t, 0);
  assert.equal(byId.get('9005').oid, '1261813571425140001');

  const urls = callsOf(client, 'getJson').map((call) => call.url);
  assert.equal(urls.length, 3);
  assert.equal(urls[0], `${API.msgfeed}/reply?platform=web&build=0&mobi_app=web`);
  assert.equal(new URL(urls[1]).searchParams.get('cursor'), 'cursor-1');
  assert.equal(new URL(urls[2]).searchParams.get('cursor'), 'cursor-2');
});

test('pullInbox：at 收件箱走对应接口，未知 kind 直接报错', async () => {
  const client = fakeClient({
    async getJson(url) {
      assert.ok(url.startsWith(`${API.msgfeed}/at?platform=web&build=0&mobi_app=web`), url);
      return {
        code: 0,
        data: {
          cursor: '',
          last_view_at: 1700000900,
          items: [{ id: 1, at_time: 1700000000, user: { nickname: '小明', mid: 5 }, item: { uri: 'https://t.bilibili.com/1261813571425140001#reply2', business_id: 17 } }],
        },
      };
    },
  });
  const api = createCommentApi(client);
  const { items, lastView } = await api.pullInbox('at');
  assert.equal(lastView, 1700000900);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'at');
  assert.equal(items[0].t, 1700000000);
  assert.equal(items[0].oid, '1261813571425140001');

  await assert.rejects(api.pullInbox('dm'), /只能是 reply 或 at/);
});

test('resolveLatestReply：parent 精确匹配优先，否则退回该 mid 最后一条并标 exact:false', async () => {
  const threadReplies = [
    { rpid: 2290000001, mid: 700001, parent: 2291234567899, content: { message: '更早的一条' }, ctime: 100 },
    { rpid: 2290000002, mid: 700001, parent: 2291234567890, content: { message: '对号入座的那条' }, ctime: 200 },
    { rpid: 2290000003, mid: 700001, parent: 2291234999999, content: { message: '后来的一句' }, ctime: 300 },
    { rpid: 2290000004, mid: 700002, parent: 2291234567890, content: { message: '别人回的同一条' }, ctime: 310 },
  ];
  const urls = [];
  const client = fakeClient({
    async getJson(url) {
      urls.push(url);
      return { code: 0, data: { replies: threadReplies } };
    },
  });
  const api = createCommentApi(client);

  const exact = await api.resolveLatestReply({
    business: 17,
    oid: EXACT_DYNAMIC_ID,
    root: '2291234567890',
    mid: '700001',
    parentRpid: '2291234567890',
  });
  assert.deepEqual(exact, { rpid: '2290000002', text: '对号入座的那条', ctime: 200, exact: true });

  const first = new URL(urls[0]);
  assert.equal(first.pathname, '/x/v2/reply/reply');
  assert.equal(first.searchParams.get('type'), '17');
  assert.equal(first.searchParams.get('oid'), EXACT_DYNAMIC_ID);
  assert.equal(first.searchParams.get('root'), '2291234567890');
  assert.equal(first.searchParams.get('ps'), '20');
  assert.equal(first.searchParams.get('pn'), '1');

  // parent 对不上 → 取该 mid 最后一条，并明确标注不精确
  const loose = await api.resolveLatestReply({
    business: 3,
    oid: '12345',
    root: '2291234567890',
    mid: '700001',
    parentRpid: '2290000000',
  });
  assert.deepEqual(loose, { rpid: '2290000003', text: '后来的一句', ctime: 300, exact: false });
  assert.equal(new URL(urls[1]).searchParams.get('type'), '1', 'business 3 应按视频（type=1）读');

  // 楼里没有这个人 → null
  const missing = await api.resolveLatestReply({ business: 17, oid: '1', root: '2', mid: '700999', parentRpid: '3' });
  assert.equal(missing, null);
});

test('resolveLatestReply：第一页读不到 → null；参数不全不发请求', async () => {
  const failing = createCommentApi(fakeClient({
    async getJson() {
      throw new Error('楼层不存在');
    },
  }));
  assert.equal(await failing.resolveLatestReply({ business: 1, oid: '1', root: '2', mid: '3' }), null);

  const idle = createCommentApi(fakeClient({
    async getJson() {
      throw new Error('不该被调用');
    },
  }));
  assert.equal(await idle.resolveLatestReply({ business: 1, mid: '7' }), null);
});

test('resolveLatestReply：最多翻 6 页', async () => {
  const page = Array.from({ length: 20 }, (_, i) => ({
    rpid: 1000 + i,
    mid: 999999,
    parent: 1,
    content: { message: '别人的' },
    ctime: i,
  }));
  let calls = 0;
  const api = createCommentApi(fakeClient({
    async getJson() {
      calls += 1;
      return { code: 0, data: { replies: page } };
    },
  }));
  const out = await api.resolveLatestReply({ business: 1, oid: '1', root: '2', mid: '700001', parentRpid: '3' });
  assert.equal(out, null);
  assert.equal(calls, 6);
});

test('post：字段齐全、成功返回 rpid、只有给 bvid 才拼链接', async () => {
  const calls = [];
  const client = fakeClient({
    async postForm(url, fields) {
      calls.push({ url, fields });
      return { httpStatus: 200, code: 0, message: '0', data: { rpid: 2291234666999, rpid_str: '2291234666999' } };
    },
  });
  const api = createCommentApi(client);

  const ok = await api.post({
    oid: EXACT_DYNAMIC_ID,
    type: 11,
    message: '你好呀',
    root: 2291234567890,
    parent: 2291234567899,
  });
  assert.deepEqual(ok, { rpid: '2291234666999', url: '' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, API.add);
  assert.deepEqual(calls[0].fields, {
    oid: EXACT_DYNAMIC_ID,
    type: 11,
    message: '你好呀',
    root: 2291234567890,
    parent: 2291234567899,
    plat: 1,
  });

  const withBv = await api.post({ oid: '170001', message: '顶层评论', bvid: 'BV1xx411c7mD' });
  assert.equal(withBv.url, 'https://www.bilibili.com/video/BV1xx411c7mD#reply2291234666999');
  assert.deepEqual(calls[1].fields, {
    oid: '170001',
    type: 1,
    message: '顶层评论',
    root: 0,
    parent: 0,
    plat: 1,
  });
});

test('post：code!==0 抛带 code/message 的错，且不重复提交', async () => {
  const calls = [];
  const client = fakeClient({
    async postForm(url, fields) {
      calls.push({ url, fields });
      return { httpStatus: 200, code: 12002, message: '评论区已关闭' };
    },
  });
  const api = createCommentApi(client);
  await assert.rejects(api.post({ oid: '170001', message: '发不出去' }), (error) => {
    assert.equal(error.code, 12002);
    assert.match(error.message, /12002/);
    assert.match(error.message, /评论区已关闭/);
    return true;
  });
  assert.equal(calls.length, 1, '12002 不是签名问题，不该带 wbi 重试');
});

test('post：签名/风控类失败带 wbi 重试一次；签名本身失败就降级不崩', async () => {
  const posts = [];
  const client = fakeClient({
    async postForm(url) {
      posts.push(url);
      if (posts.length === 1) return { httpStatus: 200, code: -352, message: '风控校验失败' };
      return { httpStatus: 200, code: 0, message: '0', data: { rpid_str: '2291234777888' } };
    },
    async signedQuery() {
      return 'w_rid=abc&wts=1700000000';
    },
  });
  const api = createCommentApi(client);
  const out = await api.post({ oid: '170001', message: '再试一次' });
  assert.deepEqual(out, { rpid: '2291234777888', url: '' });
  assert.equal(posts.length, 2);
  assert.equal(posts[0], API.add);
  assert.equal(posts[1], `${API.add}?w_rid=abc&wts=1700000000`);
  assert.equal(callsOf(client, 'signedQuery').length, 1);
  assert.equal(callsOf(client, 'signedQuery')[0].params.oid, '170001');

  // 签名拿不到 → 退回不带签名（不会二次提交），错误照原样抛
  const brokenCalls = [];
  const broken = createCommentApi(fakeClient({
    async postForm() {
      brokenCalls.push(Date.now());
      return { httpStatus: 200, code: -352, message: '风控校验失败' };
    },
    async signedQuery() {
      throw new Error('nav code=-101 未登录');
    },
  }), { logger: () => {} });
  await assert.rejects(broken.post({ oid: '170001', message: 'x' }), (error) => error.code === -352);
  assert.equal(brokenCalls.length, 1);
});

test('post：缺 oid / 正文直接报错，不发请求', async () => {
  const client = fakeClient({
    async postForm() {
      throw new Error('不该发请求');
    },
  });
  const api = createCommentApi(client);
  await assert.rejects(api.post({ oid: '', message: 'x' }), /oid/);
  await assert.rejects(api.post({ oid: '170001', message: '   ' }), /message/);
  await assert.rejects(api.post({ oid: '170001', message: 'x', type: 12 }), /type=12/);
  assert.equal(client.calls.length, 0);
});

test('list：解析顶层评论 + 二级回复摘要（不递归）', async () => {
  const raw = {
    code: 0,
    data: {
      page: { pn: 1, size: 20, count: 37 },
      replies: [
        {
          rpid: 2290000001,
          mid: 700001,
          member: { uname: '阿黄' },
          content: { message: '顶层评论' },
          like: 12,
          ctime: 1700000000,
          replies: [
            {
              rpid: 2290000002,
              mid: 700002,
              member: { uname: '小蓝' },
              content: { message: '二级回复' },
              like: 1,
              ctime: 1700000100,
              replies: [{ rpid: 1, mid: 2, content: { message: '更深一层' } }],
            },
          ],
        },
        {
          rpid: 2290000010,
          mid: 700003,
          member: { uname: '没回复的' },
          content: { message: '二层空' },
          like: 0,
          ctime: 1700000200,
          replies: null,
        },
      ],
    },
  };
  const client = fakeClient({ async getJson() { return raw; } });
  const api = createCommentApi(client);
  const out = await api.list({ oid: '170001', type: 11, pn: 2, ps: 10, sort: 1 });

  assert.deepEqual(out.page, { pn: 1, ps: 20, count: 37 });
  assert.equal(out.items.length, 2);
  assert.deepEqual(out.items[0], {
    rpid: '2290000001',
    mid: '700001',
    uname: '阿黄',
    message: '顶层评论',
    like: 12,
    ctime: 1700000000,
    replies: [
      { rpid: '2290000002', mid: '700002', uname: '小蓝', message: '二级回复', like: 1, ctime: 1700000100 },
    ],
  });
  assert.equal(Object.hasOwn(out.items[0].replies[0], 'replies'), false, '二级回复只留摘要，不带嵌套');
  assert.deepEqual(out.items[1].replies, []);

  const call = callsOf(client, 'getJson')[0];
  const url = new URL(call.url);
  assert.equal(url.pathname, '/x/v2/reply');
  assert.equal(url.searchParams.get('type'), '11');
  assert.equal(url.searchParams.get('oid'), '170001');
  assert.equal(url.searchParams.get('pn'), '2');
  assert.equal(url.searchParams.get('ps'), '10');
  assert.equal(url.searchParams.get('sort'), '1');
  assert.equal(call.options.referer, 'https://www.bilibili.com/opus/170001');
});

test('list：没有评论时返回空列表', async () => {
  const api = createCommentApi(fakeClient({
    async getJson() {
      return { code: 0, data: { page: { pn: 1, size: 20, count: 0 }, replies: null } };
    },
  }));
  const out = await api.list({ oid: '170001' });
  assert.deepEqual(out.items, []);
  assert.equal(out.page.count, 0);
});

test('remove：POST /x/v2/reply/del，成功 ok:true，失败抛 code', async () => {
  const calls = [];
  const client = fakeClient({
    async postForm(url, fields) {
      calls.push({ url, fields });
      return { httpStatus: 200, code: 0, message: '0' };
    },
  });
  const api = createCommentApi(client);
  assert.deepEqual(await api.remove({ oid: '170001', type: 1, rpid: '2291234666999' }), { ok: true });
  assert.equal(calls[0].url, API.del);
  assert.deepEqual(calls[0].fields, { oid: '170001', type: 1, rpid: '2291234666999' });

  const failing = createCommentApi(fakeClient({
    async postForm() {
      return { httpStatus: 200, code: -404, message: '啥都木有' };
    },
  }));
  await assert.rejects(failing.remove({ oid: '170001', rpid: '1' }), (error) => {
    assert.equal(error.code, -404);
    assert.match(error.message, /啥都木有/);
    return true;
  });
});

test('createCommentApi：客户端不对直接报错', () => {
  assert.throws(() => createCommentApi(null), /getJson/);
  assert.throws(() => createCommentApi({}), /getJson/);
});
