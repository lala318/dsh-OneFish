#!/usr/bin/env node
/**
 * video.js 的离线单测：注入假 fetchImpl + 真实 createBiliClient（WBI 也一起跑），
 * 不联网、不调 ffmpeg。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBiliClient } from '../lib/http.js';
import { createVideoApi } from '../lib/video.js';

const NAV = {
  code: 0,
  data: {
    wbi_img: {
      img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
      sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
    },
  },
};

const BVID = 'BV1xx411c7mD';
const VIEW = {
  code: 0,
  data: {
    bvid: BVID,
    aid: 114514,
    cid: 2233,
    title: '测试视频',
    desc: '简介文本',
    duration: 125,
    pubdate: 1700000000,
    pic: 'https://i0.hdslb.com/cover.jpg',
    owner: { mid: 42, name: 'UP主' },
    stat: { view: 1000, like: 50, coin: 20, favorite: 10, reply: 3, danmaku: 7 },
  },
};

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/**
 * 造一个只认本地路由的 fetchImpl。nav 由 harness 自动兜住（WBI 需要），
 * 其余按 URL 片段匹配，也可以直接返回 Response（下载测试用）。
 */
function makeHarness(routes = {}, config = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.includes('/x/web-interface/nav')) return jsonResponse(NAV);
    for (const [fragment, handler] of Object.entries(routes)) {
      if (!u.includes(fragment)) continue;
      const body = typeof handler === 'function' ? await handler(u, init) : handler;
      return body instanceof Response ? body : jsonResponse(body);
    }
    throw new Error(`测试没有准备这个请求的响应：${u}`);
  };
  const client = createBiliClient(
    { sessdata: 'fake-sessdata', bili_jct: 'fake-jct', buvid3: 'fake-buvid3', mid: '100', name: '测试鱼' },
    { fetchImpl, logger: () => {} },
  );
  const api = createVideoApi(client, { config, logger: () => {}, fetchImpl });
  return { api, client, calls };
}

// ── 1. info ─────────────────────────────────────────────────────────

test('info：解析 view，并额外拉标签', async () => {
  const h = makeHarness({
    '/x/web-interface/view': VIEW,
    '/x/tag/archive/tags': { code: 0, data: [{ tag_name: '测试' }, { tag_name: 'B站' }, { tag_name: '' }] },
  });
  const info = await h.api.info({ bvid: BVID });
  assert.deepEqual(info, {
    aid: 114514,
    cid: 2233,
    title: '测试视频',
    desc: '简介文本',
    duration: 125,
    pubdate: 1700000000,
    pic: 'https://i0.hdslb.com/cover.jpg',
    owner: { mid: 42, name: 'UP主' },
    tags: ['测试', 'B站'],
    stat: { view: 1000, like: 50, coin: 20, favorite: 10, reply: 3 },
  });
  assert.match(h.calls[0].url, /\/x\/web-interface\/view\?bvid=BV1xx411c7mD/);

  // 只给 aid 时走 view?aid，并顺带拿到 bvid 再拉标签
  const byAid = makeHarness({ '/x/web-interface/view': VIEW, '/x/tag/archive/tags': { code: 0, data: [] } });
  const info2 = await byAid.api.info({ aid: 114514 });
  assert.equal(info2.aid, 114514);
  assert.equal(info2.cid, 2233);
  assert.deepEqual(info2.tags, []);
  assert.match(byAid.calls[0].url, /\/x\/web-interface\/view\?aid=114514/);
});

test('info：标签接口失败时降级为空数组，不影响主信息', async () => {
  const h = makeHarness({
    '/x/web-interface/view': VIEW,
    '/x/tag/archive/tags': { code: -412, message: '请求被拦截' },
  });
  const info = await h.api.info({ bvid: BVID });
  assert.equal(info.title, '测试视频');
  assert.deepEqual(info.tags, []);
});

// ── 2. 字幕 ─────────────────────────────────────────────────────────

test('subtitles：中文优先（AI 中文优先），解析 body，字幕 CDN 不带 cookie', async () => {
  const h = makeHarness({
    '/x/web-interface/view': VIEW,
    '/x/player/wbi/v2': {
      code: 0,
      data: {
        subtitle: {
          subtitles: [
            { lan: 'en', lan_doc: 'English', subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/en.json' },
            { lan: 'zh-CN', lan_doc: '中文（简体）', subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/zh.json' },
            { lan: 'ai-zh', lan_doc: '中文（AI生成）', subtitle_url: 'https://aisubtitle.hdslb.com/bfs/subtitle/ai.json' },
          ],
        },
      },
    },
    aisubtitle: {
      body: [
        { from: 0.5, to: 2.1, content: '第一句' },
        { from: 2.1, to: 4.02, content: '第二句' },
        { from: 4.02, to: 5, content: '   ' },
      ],
    },
  });

  const result = await h.api.subtitles({ bvid: BVID });
  assert.deepEqual(result, {
    bvid: BVID,
    title: '测试视频',
    lang: 'ai-zh',
    lanDoc: '中文（AI生成）',
    lines: [
      { from: 0.5, to: 2.1, text: '第一句' },
      { from: 2.1, to: 4.02, text: '第二句' },
    ],
    text: '第一句\n第二句',
    ai: true,
  });

  const player = h.calls.find((call) => call.url.includes('/x/player/wbi/v2'));
  assert.ok(player, '应请求 wbi/v2');
  assert.match(player.url, /bvid=BV1xx411c7mD/);
  assert.match(player.url, /cid=2233/);
  assert.match(player.url, /w_rid=/);

  const cdn = h.calls.find((call) => call.url.includes('aisubtitle'));
  assert.ok(cdn, '应下载字幕 JSON');
  assert.match(cdn.url, /subtitle\/ai\.json/, '应选 AI 中文轨');
  assert.equal(cdn.init.headers.cookie, undefined, '字幕 CDN 不该带 cookie');
  assert.match(cdn.init.headers.referer, /bilibili\.com\/video\/BV1xx411c7mD/);
});

test('subtitles：没有 AI 中文时用官方中文，没有中文轨时退到任意轨', async () => {
  const officialOnly = makeHarness({
    '/x/web-interface/view': VIEW,
    '/x/player/wbi/v2': {
      code: 0,
      data: {
        subtitle: {
          subtitles: [
            { lan: 'en', lan_doc: 'English', subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/en.json' },
            { lan: 'zh-CN', lan_doc: '中文（简体）', subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/zh.json' },
          ],
        },
      },
    },
    aisubtitle: { body: [{ from: 0, to: 1.5, content: '官方字幕' }] },
  });
  const official = await officialOnly.api.subtitles({ bvid: BVID });
  assert.equal(official.lang, 'zh-CN');
  assert.equal(official.ai, false);
  assert.equal(official.text, '官方字幕');
  assert.match(officialOnly.calls.find((call) => call.url.includes('aisubtitle')).url, /subtitle\/zh\.json/);

  const foreign = makeHarness({
    '/x/web-interface/view': VIEW,
    '/x/player/wbi/v2': {
      code: 0,
      data: {
        subtitle: {
          subtitles: [{ lan: 'en', lan_doc: 'English', subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/en.json' }],
        },
      },
    },
    aisubtitle: { body: [{ from: 0, to: 1, content: 'Only English' }] },
  });
  const anyTrack = await foreign.api.subtitles({ bvid: BVID });
  assert.equal(anyTrack.lang, 'en');
  assert.equal(anyTrack.ai, false);
  assert.equal(anyTrack.text, 'Only English');
});

// ── 3. 评论 ─────────────────────────────────────────────────────────

test('comments：解析分页与楼层，允许 oid/type 覆盖（动态评论）', async () => {
  const replyBody = {
    code: 0,
    data: {
      page: { pn: 1, ps: 20, count: 42 },
      replies: [
        {
          rpid: 111,
          mid: 7,
          like: 9,
          ctime: 1700000000,
          member: { mid: 7, uname: '甲' },
          content: { message: '好活' },
          replies: [
            { rpid: 222, mid: 8, like: 1, ctime: 1700000001, member: { mid: 8, uname: '乙' }, content: { message: '同意' } },
          ],
        },
      ],
    },
  };
  const h = makeHarness({ '/x/web-interface/view': VIEW, '/x/v2/reply': replyBody });

  const result = await h.api.comments({ bvid: BVID });
  assert.deepEqual(result, {
    page: { pn: 1, ps: 20, count: 42 },
    items: [
      {
        rpid: 111,
        mid: 7,
        uname: '甲',
        message: '好活',
        like: 9,
        ctime: 1700000000,
        replies: [{ rpid: 222, mid: 8, uname: '乙', message: '同意', like: 1, ctime: 1700000001 }],
      },
    ],
  });
  const replyCall = h.calls.find((call) => call.url.includes('/x/v2/reply'));
  assert.match(replyCall.url, /type=1/);
  assert.match(replyCall.url, /oid=114514/);
  assert.match(replyCall.url, /sort=2/);

  // 给了 oid 就不再打 view，type 也能换（动态评论）
  const before = h.calls.length;
  await h.api.comments({ bvid: BVID, oid: 999, type: 17, ps: 5 });
  const extra = h.calls.slice(before);
  assert.equal(extra.length, 1);
  assert.match(extra[0].url, /type=17/);
  assert.match(extra[0].url, /oid=999/);
  assert.match(extra[0].url, /ps=5/);
});

// ── 4. 播放直链 ─────────────────────────────────────────────────────

test('playUrl：durl 与 dash 两种返回都能取到直链', async () => {
  let playBody = {
    code: 0,
    data: {
      quality: 64,
      durl: [{ url: 'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/aa/bb/video.mp4?deadline=1', size: 1048576 }],
    },
  };
  const h = makeHarness({ '/x/web-interface/view': VIEW, '/x/player/playurl': () => playBody });

  // bvid + cid 就够签名，不该多打一次 view
  const durl = await h.api.playUrl({ bvid: BVID, cid: 2233, qn: 80 });
  assert.deepEqual(durl, {
    urls: ['https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/aa/bb/video.mp4?deadline=1'],
    quality: 64,
    format: 'mp4',
    sizeBytes: 1048576,
  });
  assert.equal(h.calls.filter((call) => call.url.includes('/x/web-interface/view')).length, 0);
  const playCall = h.calls.find((call) => call.url.includes('/x/player/playurl'));
  assert.match(playCall.url, /bvid=BV1xx411c7mD/);
  assert.match(playCall.url, /cid=2233/);
  assert.match(playCall.url, /qn=80/);
  assert.match(playCall.url, /fnval=1/);
  assert.match(playCall.url, /w_rid=/);

  // dash：baseUrl + backupUrl 都留着
  playBody = {
    code: 0,
    data: {
      quality: 80,
      dash: {
        video: [
          {
            id: 80,
            baseUrl: 'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/cc/video.m4s?x=1',
            backupUrl: ['https://upos-sz-mirrorali.bilivideo.com/upgcxcode/cc/video.m4s?x=1'],
            size: 2048,
          },
        ],
      },
    },
  };
  const dash = await h.api.playUrl({ bvid: BVID, cid: 2233 });
  assert.deepEqual(dash, {
    urls: [
      'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/cc/video.m4s?x=1',
      'https://upos-sz-mirrorali.bilivideo.com/upgcxcode/cc/video.m4s?x=1',
    ],
    quality: 80,
    format: 'dash',
    sizeBytes: 2048,
  });

  // 只给 bvid：先 view 补 cid
  playBody = { code: 0, data: { quality: 64, durl: [{ url: 'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/aa/bb/video.mp4', size: 9 }] } };
  const auto = await h.api.playUrl({ bvid: BVID });
  assert.equal(auto.quality, 64);
  assert.equal(h.calls.filter((call) => call.url.includes('/x/web-interface/view')).length, 1);
});

// ── 5. 抽帧：ffmpeg 缺失要清晰报错 ──────────────────────────────────

test('frames：ffmpeg 不存在时直接报错，且不发网络请求', async () => {
  const missing = path.join(os.tmpdir(), 'onefish-no-such-ffmpeg.exe');
  const h = makeHarness({}, { video: { ffmpegPath: missing } });
  await assert.rejects(
    () => h.api.frames({ bvid: BVID, count: 4, outDir: path.join(os.tmpdir(), 'onefish-bili-frames-test') }),
    (error) => {
      assert.match(String(error?.message), /ffmpeg/);
      assert.match(String(error?.message), /ffmpegPath/);
      assert.match(String(error?.message), /不存在/);
      return true;
    },
  );
  assert.equal(h.calls.length, 0, 'ffmpeg 缺了就不该先发网络请求');
});

// ── 6. 下载（额外覆盖落盘契约）──────────────────────────────────────

test('download：直链落盘成功后才返回，带字节数', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onefish-bili-download-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const videoBytes = Buffer.alloc(4096, 7);
  const h = makeHarness({
    '/x/web-interface/view': VIEW,
    '/x/player/playurl': {
      code: 0,
      data: { quality: 64, durl: [{ url: 'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/aa/bb/video.mp4', size: videoBytes.length }] },
    },
    'upos-sz': () => new Response(videoBytes, { status: 200 }),
  });

  const saved = await h.api.download({ bvid: BVID, outDir: dir });
  assert.equal(saved.file, path.join(path.resolve(dir), `${BVID}.mp4`));
  assert.equal(saved.bytes, videoBytes.length);
  assert.equal(saved.quality, 64);
  assert.equal(fs.statSync(saved.file).size, videoBytes.length);
  assert.equal(fs.readFileSync(saved.file, 'utf8').length > 0, true);

  const cdn = h.calls.find((call) => call.url.includes('upos-sz'));
  assert.equal(cdn.init.headers.cookie, undefined, '视频 CDN 不该带 cookie');
});
