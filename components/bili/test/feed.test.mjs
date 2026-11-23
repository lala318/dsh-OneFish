#!/usr/bin/env node
/**
 * feed 单测：三种流走同一套字段，非稿件条目跳过，参数落到正确的接口上。
 * 全部用假 client，不联网。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createFeedApi, normalizeFeedItem } from '../lib/feed.js';

function fakeClient({ json = {}, signed = 'ps=20&w_rid=deadbeef' } = {}) {
  const calls = [];
  return {
    calls,
    async signedQuery(params) {
      calls.push({ kind: 'sign', params });
      return signed;
    },
    async getJson(url, options) {
      calls.push({ kind: 'get', url, options });
      return typeof json === 'function' ? json(url) : json;
    },
  };
}

const avItem = {
  bvid: 'BV1xx411c7mD',
  aid: 170001,
  cid: 123,
  title: '测试稿件',
  duration: 610,
  pubdate: 1795168800,
  desc: '简介'.repeat(100),
  owner: { mid: 42, name: '某UP' },
  stat: { view: 10000, like: 200, danmaku: 30 },
};

test('normalizeFeedItem：缺 bvid 的条目返回 null（直播/广告跳过）', () => {
  assert.equal(normalizeFeedItem({ goto: 'live', title: '直播间' }), null);
  assert.equal(normalizeFeedItem(null), null);
  assert.equal(normalizeFeedItem(avItem).bvid, 'BV1xx411c7mD');
});

test('normalizeFeedItem：字段齐全、简介截断、带可点链接', () => {
  const item = normalizeFeedItem(avItem);
  assert.equal(item.owner, '某UP');
  assert.equal(item.views, 10000);
  assert.equal(item.likes, 200);
  assert.equal(item.duration, 610);
  assert.ok(item.desc.length <= 140);
  assert.equal(item.url, 'https://www.bilibili.com/video/BV1xx411c7mD');
});

test('recommend：走 WBI 签名接口，跳过非稿件并记数', async () => {
  const client = fakeClient({
    json: { code: 0, data: { item: [avItem, { goto: 'live', title: '直播' }, { goto: 'av', bvid: 'BV1yy411c7mD', title: 'B' }] } },
  });
  const feed = createFeedApi(client);
  const result = await feed.list({ kind: 'recommend', ps: 12, freshIdx: 3 });
  assert.equal(result.kind, 'recommend');
  assert.equal(result.count, 2);
  assert.equal(result.skipped, 1);
  const sign = client.calls.find((call) => call.kind === 'sign');
  assert.equal(sign.params.ps, 12);
  assert.equal(sign.params.fresh_idx, 3);
  const get = client.calls.find((call) => call.kind === 'get');
  assert.match(get.url, /web-interface\/wbi\/index\/top\/feed\/rcmd\?/);
  assert.match(get.url, /w_rid=deadbeef/);
});

test('popular：分页参数落到 URL，no_more 透传', async () => {
  const client = fakeClient({ json: { code: 0, data: { list: [avItem], no_more: true } } });
  const feed = createFeedApi(client);
  const result = await feed.list({ kind: 'popular', ps: 20, pn: 2 });
  assert.equal(result.pn, 2);
  assert.equal(result.noMore, true);
  assert.match(client.calls[0].url, /ps=20&pn=2$/);
});

test('ranking：rid 透传，默认全站', async () => {
  const client = fakeClient({ json: { code: 0, data: { list: [avItem] } } });
  const feed = createFeedApi(client);
  assert.equal((await feed.list({ kind: 'ranking' })).rid, 0);
  assert.match(client.calls[0].url, /rid=0&type=all$/);
  await feed.list({ kind: 'ranking', rid: 17 });
  assert.match(client.calls[1].url, /rid=17&type=all$/);
});

test('未知流明确报错，不静默给空列表', async () => {
  const feed = createFeedApi(fakeClient());
  await assert.rejects(() => feed.list({ kind: 'hot-list' }), /不认识的流/);
});

test('client 不完整时创建就报错', () => {
  assert.throws(() => createFeedApi({ getJson() {} }), /createBiliClient/);
});
