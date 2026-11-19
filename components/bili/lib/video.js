/**
 * B站「看视频」：元信息 / 字幕 / 评论 / 播放直链 / 下载 / 抽帧九宫格。
 *
 * 设计：
 * - 只做业务编排：cookie 头、WBI 签名、配置归一化复用 http.js / config.js；
 * - 所有网络请求都走注入的 fetchImpl（测试可替换），错误信息里不带 cookie；
 * - ffmpeg 是外部依赖：找不到就明确抛错，绝不假装抽帧成功；
 * - 这里只「备素材」（文字 + 图），看不看懂、下什么结论留给模型。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { BiliError, UA } from './http.js';
import { normalizeConfig } from './config.js';

const API = 'https://api.bilibili.com';
const FETCH_TIMEOUT_MS = 20 * 1000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const FFMPEG_TIMEOUT_MS = 120 * 1000;

// ── 小工具（纯函数）────────────────────────────────────────────────

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function toText(value, fallback = '') {
  return String(value ?? '').trim() || fallback;
}

function videoReferer(bvid = '') {
  return bvid ? `https://www.bilibili.com/video/${bvid}/` : 'https://www.bilibili.com/';
}

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** 老 surfcore 留下的 ffmpeg（只在这台机器上可能有）；按规格作为第三顺位，存在才用。 */
function legacyFfmpegPath() {
  return path.join(os.homedir(), '.dsh', 'surfcore', 'bili', 'bin', 'ffmpeg.exe');
}

/**
 * 选字幕轨：中文优先（lan 含 zh），中文里 AI 字幕（ai-zh）优先 —— 跟组件 MCP 描述
 * 「有 AI 字幕就用 AI 字幕」一致，AI 字幕跟着音频走、覆盖最全；没有 AI 中文再退
 * 官方中文，再不行任意一条。
 */
function pickSubtitle(tracks) {
  const list = Array.isArray(tracks) ? tracks.filter(Boolean) : [];
  const chinese = list.filter((track) => /zh/i.test(toText(track?.lan)));
  const aiChinese = chinese.find((track) => /^ai/i.test(toText(track.lan)));
  const officialChinese = chinese.find((track) => !/^ai/i.test(toText(track.lan)));
  return aiChinese ?? officialChinese ?? list[0] ?? null;
}

/** 字幕 CDN 常给 `//host/path`，补成 https。 */
function absoluteSubtitleUrl(value) {
  const raw = toText(value);
  if (!raw) return '';
  return raw.startsWith('//') ? `https:${raw}` : raw;
}

/** 字幕 body → [{from,to,text}]，空文本行直接丢掉。 */
function subtitleLines(body) {
  if (!Array.isArray(body)) return [];
  const lines = [];
  for (const item of body) {
    const text = toText(item?.content);
    if (!text) continue;
    const from = Number(item?.from);
    const to = Number(item?.to);
    const start = Number.isFinite(from) ? from : 0;
    lines.push({ from: start, to: Number.isFinite(to) ? to : start, text });
  }
  return lines;
}

/** 评论楼层（一级/二级共用）。 */
function mapReply(reply) {
  return {
    rpid: toInt(reply?.rpid),
    mid: toInt(reply?.mid ?? reply?.member?.mid),
    uname: toText(reply?.member?.uname),
    message: toText(reply?.content?.message),
    like: toInt(reply?.like),
    ctime: toInt(reply?.ctime),
    replies: Array.isArray(reply?.replies) ? reply.replies.map(mapSubReply) : [],
  };
}

/** 二级评论没有 replies 字段，别让形状漂移。 */
function mapSubReply(reply) {
  return {
    rpid: toInt(reply?.rpid),
    mid: toInt(reply?.mid ?? reply?.member?.mid),
    uname: toText(reply?.member?.uname),
    message: toText(reply?.content?.message),
    like: toInt(reply?.like),
    ctime: toInt(reply?.ctime),
  };
}

/** view 接口 → 统一结构（不含 tags；tags 要额外拉一次）。 */
function parseView(data) {
  const stat = data?.stat ?? {};
  return {
    bvid: toText(data?.bvid),
    aid: toInt(data?.aid),
    cid: toInt(data?.cid ?? data?.pages?.[0]?.cid),
    title: toText(data?.title),
    desc: toText(data?.desc),
    duration: toInt(data?.duration),
    pubdate: toInt(data?.pubdate),
    pic: toText(data?.pic),
    owner: { mid: toInt(data?.owner?.mid), name: toText(data?.owner?.name) },
    stat: {
      view: toInt(stat.view),
      like: toInt(stat.like),
      coin: toInt(stat.coin),
      favorite: toInt(stat.favorite),
      reply: toInt(stat.reply),
    },
  };
}

/** 从直链猜容器后缀，猜不到按 .mp4 处理。 */
function guessExt(url) {
  try {
    const ext = path.extname(new URL(String(url)).pathname).toLowerCase();
    if (['.mp4', '.flv', '.m4s', '.ts'].includes(ext)) return ext;
  } catch {}
  return '.mp4';
}

/** execFile 的 Promise 版：带超时，失败时把 stderr 末尾几行塞进错误。 */
function execFileAsync(bin, args, { timeoutMs = FFMPEG_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr });
          return;
        }
        const tail = String(stderr || error.stderr || '')
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(-6)
          .join('\n');
        const why = error.killed
          ? `超时（${Math.round(timeoutMs / 1000)} 秒）`
          : error.code === 'ENOENT'
            ? '找不到可执行文件'
            : `退出码 ${error.code ?? '未知'}`;
        reject(new BiliError(`ffmpeg 执行失败：${why}${tail ? `\n${tail}` : ''}`));
      },
    );
  });
}

// ── 主体 ────────────────────────────────────────────────────────────

/**
 * @param {ReturnType<typeof import('./http.js').createBiliClient>} client
 * @param {{config?:object, logger?:Function, fetchImpl?:Function}} options
 *   config 建议直接传组件的归一化配置；里面只读 video.*（ffmpegPath / workDir /
 *   downloadDir / maxFrames）。
 */
export function createVideoApi(client, { config = {}, logger = () => {}, fetchImpl = fetch } = {}) {
  if (!client || typeof client.getJson !== 'function' || typeof client.signedQuery !== 'function') {
    throw new TypeError('createVideoApi(client) 需要 createBiliClient 返回的客户端');
  }
  const videoCfg = normalizeConfig(config).video;
  const log = (message) => logger(message);

  /**
   * CDN 用的请求头：复用 client.headers（UA / referer），但摘掉 cookie 和 origin ——
   * 字幕与视频走的是 CDN/镜像域名，不需要凭据，也不该把 cookie 发过去。
   */
  function cdnHeaders(bvid) {
    const referer = videoReferer(bvid);
    let headers = { 'user-agent': UA, referer };
    if (typeof client.headers === 'function') headers = { ...client.headers(referer) };
    delete headers.cookie;
    delete headers.origin;
    return headers;
  }

  async function fetchText(url, { bvid = '', timeoutMs = FETCH_TIMEOUT_MS } = {}) {
    let response;
    try {
      response = await fetchImpl(url, { headers: cdnHeaders(bvid), signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const reason = error?.name === 'TimeoutError' ? '超时' : toText(error?.message, String(error));
      throw new BiliError(`请求失败：${reason}`, { url });
    }
    if (!response.ok) throw new BiliError(`请求失败 HTTP ${response.status}（${url}）`, { status: response.status, url });
    return response.text();
  }

  // ── 视频基础信息 ──────────────────────────────────────────────────

  /** 只打 view 接口，返回原始 data。bvid 优先；只有 aid 时走 view?aid。 */
  async function viewOf({ bvid, aid } = {}) {
    const bv = toText(bvid);
    const av = toInt(aid);
    if (!bv && !av) throw new BiliError('需要 bvid 或 aid');
    const query = bv ? `bvid=${encodeURIComponent(bv)}` : `aid=${av}`;
    const json = await client.getJson(`${API}/x/web-interface/view?${query}`, { referer: videoReferer(bv) });
    if (!json?.data || typeof json.data !== 'object') throw new BiliError('view 接口没返回视频信息');
    return json.data;
  }

  /** view → 内部引用（bvid / aid / cid / 标题 / 时长…），供各方法复用。 */
  async function refOf(options) {
    const ref = parseView(await viewOf(options));
    if (!ref.bvid || !ref.aid) throw new BiliError('view 接口返回的视频信息不完整（缺 bvid / aid）');
    return ref;
  }

  function requireCid(ref) {
    if (!ref?.cid) throw new BiliError(`拿不到视频 cid（${ref?.bvid || ref?.aid || '未知视频'}）`);
    return ref.cid;
  }

  /** 标签：失败就降级为空数组（标签不是关键路径，别拖垮 info）。 */
  async function tagsOf(bvid) {
    if (!bvid) return [];
    try {
      const json = await client.getJson(`${API}/x/tag/archive/tags?bvid=${encodeURIComponent(bvid)}`, {
        referer: videoReferer(bvid),
      });
      return (Array.isArray(json?.data) ? json.data : []).map((tag) => toText(tag?.tag_name)).filter(Boolean);
    } catch (error) {
      log(`[video] 标签拉取失败（不影响 info）：${toText(error?.message, String(error))}`);
      return [];
    }
  }

  async function info({ bvid, aid } = {}) {
    const ref = await refOf({ bvid, aid });
    const tags = await tagsOf(ref.bvid);
    return {
      aid: ref.aid,
      cid: ref.cid,
      title: ref.title,
      desc: ref.desc,
      duration: ref.duration,
      pubdate: ref.pubdate,
      pic: ref.pic,
      owner: { ...ref.owner },
      tags,
      stat: { ...ref.stat },
    };
  }

  // ── 字幕 ──────────────────────────────────────────────────────────

  async function subtitles({ bvid, aid } = {}) {
    const ref = await refOf({ bvid, aid });
    const cid = requireCid(ref);
    // 必须走 WBI 签名：旧端点给的 subtitle_url 缺 auth_key，CDN 会 403。
    const query = await client.signedQuery({ bvid: ref.bvid, cid });
    const json = await client.getJson(`${API}/x/player/wbi/v2?${query}`, { referer: videoReferer(ref.bvid) });
    const tracks = Array.isArray(json?.data?.subtitle?.subtitles) ? json.data.subtitle.subtitles : [];
    const pick = pickSubtitle(tracks);
    if (!pick) {
      throw new BiliError(`这条视频没有官方字幕轨（${ref.bvid}）：可以改用 frames 抽帧看画面`);
    }
    const url = absoluteSubtitleUrl(pick.subtitle_url);
    if (!url) throw new BiliError(`字幕轨 ${toText(pick.lan)} 没有下载地址（可能需要重新登录）`);
    const raw = await fetchText(url, { bvid: ref.bvid });
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BiliError('字幕文件不是 JSON（auth_key 可能已过期，重试一次）');
    }
    const lines = subtitleLines(parsed?.body);
    if (!lines.length) throw new BiliError('字幕文件里没有文本行');
    return {
      bvid: ref.bvid,
      title: ref.title,
      lang: toText(pick.lan),
      lanDoc: toText(pick.lan_doc),
      lines,
      text: lines.map((line) => line.text).join('\n'),
      ai: /^ai/i.test(toText(pick.lan)),
    };
  }

  // ── 评论 ──────────────────────────────────────────────────────────

  async function comments({ bvid, aid, oid, type = 1, pn = 1, ps = 20, sort = 2 } = {}) {
    // 动态评论的 oid 可能不是 aid，允许调用方直接给 oid / type。
    let targetOid = toInt(oid);
    if (!targetOid) {
      targetOid = toInt(aid);
      if (!targetOid) targetOid = (await refOf({ bvid })).aid;
    }
    const page = Math.max(1, toInt(pn, 1));
    const size = Math.min(50, Math.max(1, toInt(ps, 20)));
    const params = new URLSearchParams({
      type: String(toInt(type, 1)),
      oid: String(targetOid),
      pn: String(page),
      ps: String(size),
      sort: String(toInt(sort, 2)),
    });
    const json = await client.getJson(`${API}/x/v2/reply?${params}`, { referer: videoReferer(toText(bvid)) });
    const data = json?.data ?? {};
    const rawPage = data.page ?? {};
    return {
      page: {
        pn: toInt(rawPage.pn, page),
        ps: toInt(rawPage.ps, size),
        count: toInt(rawPage.count ?? rawPage.acount, 0),
      },
      items: (Array.isArray(data.replies) ? data.replies : []).map(mapReply),
    };
  }

  // ── 播放直链 ──────────────────────────────────────────────────────

  /**
   * 调 playurl。请求参数保持 fnval=1（普通 mp4 直链，下载/抽帧最省事）；
   * 万一返回 dash，就取第一路视频流。
   */
  async function playFor({ bvid, cid }, qn) {
    const quality = toInt(qn, 80) || 80;
    const query = await client.signedQuery({
      bvid,
      cid: toInt(cid),
      qn: quality,
      fnval: 1,
      fourk: 1,
      platform: 'pc',
      high_quality: 1,
    });
    const json = await client.getJson(`${API}/x/player/playurl?${query}`, { referer: videoReferer(bvid) });
    const data = json?.data;
    const dashVideo = Array.isArray(data?.dash?.video) ? data.dash.video[0] : null;
    if (dashVideo) {
      const urls = unique(
        [dashVideo.baseUrl, ...(Array.isArray(dashVideo.backupUrl) ? dashVideo.backupUrl : [])].map((item) => toText(item)),
      );
      if (!urls.length) throw new BiliError('playurl 返回了 dash 流但没有直链');
      return {
        urls,
        quality: toInt(data?.quality ?? dashVideo.id),
        format: 'dash',
        sizeBytes: toInt(dashVideo.size),
      };
    }
    const durl = Array.isArray(data?.durl) ? data.durl : [];
    const urls = unique(durl.map((part) => toText(part?.url)));
    if (!urls.length) throw new BiliError('没拿到播放直链（可能需要登录，或这条视频只有 dash 流）');
    // 多段 durl 只认第一段（对应的 size 也是第一段的），避免把不连续的分片拼成一个坏文件。
    return {
      urls,
      quality: toInt(data?.quality),
      format: guessExt(urls[0]).replace(/^\./, '') || 'durl',
      sizeBytes: toInt(durl[0]?.size),
    };
  }

  async function playUrl({ bvid, aid, cid, qn = 80 } = {}) {
    const bv = toText(bvid);
    const fixedCid = toInt(cid);
    let ref;
    if (bv && fixedCid) {
      // 有 bvid + cid 就够签名了，不用多打一次 view
      ref = { bvid: bv, aid: toInt(aid), cid: fixedCid };
    } else {
      ref = await refOf({ bvid: bv, aid });
      if (fixedCid) ref = { ...ref, cid: fixedCid };
    }
    requireCid(ref);
    return playFor(ref, qn);
  }

  // ── 下载 ──────────────────────────────────────────────────────────

  function defaultBase(kind) {
    const downloadDir = toText(videoCfg.downloadDir);
    const workDir = toText(videoCfg.workDir);
    const base = kind === 'download' ? downloadDir || workDir : workDir;
    return base ? path.resolve(base) : path.join(os.tmpdir(), 'onefish-bili');
  }

  /** 下载到指定目录并返回落盘结果；先写 .part 再改名，失败不留半截文件。 */
  async function saveVideo(ref, outDir) {
    const cid = requireCid(ref);
    const play = await playFor({ bvid: ref.bvid, cid }, 80);
    const url = play.urls[0];
    const dir = path.resolve(outDir);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${ref.bvid}${guessExt(url)}`);
    const tmp = `${file}.part`;

    let response;
    try {
      response = await fetchImpl(url, {
        headers: { ...cdnHeaders(ref.bvid), range: 'bytes=0-' },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error?.name === 'TimeoutError' ? '超时' : toText(error?.message, String(error));
      throw new BiliError(`下载视频失败：${reason}`, { url });
    }
    if (!response.ok) throw new BiliError(`下载视频失败 HTTP ${response.status}`, { status: response.status, url });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new BiliError('下载到的视频是空文件');
    if (buffer[0] === 0x3c) {
      // 风控时 CDN 会回一页 HTML，写进 .mp4 只会让后面的 ffmpeg 报看不懂的错。
      throw new BiliError('下载到的是网页而不是视频（大概率被风控了），换条直链或稍后再试', { url });
    }

    try {
      fs.writeFileSync(tmp, buffer);
      fs.renameSync(tmp, file);
    } catch (error) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {}
      throw new BiliError(`写视频文件失败：${toText(error?.message, String(error))}`);
    }

    const bytes = fs.statSync(file).size;
    if (play.format === 'dash') log('[video] 下载到的是 dash 视频流（没有音轨，抽帧够用）');
    log(`[video] 已下载 ${ref.bvid} → ${file}（${(bytes / 1024 / 1024).toFixed(2)} MB）`);
    return { file: path.resolve(file), bytes, quality: play.quality };
  }

  async function download({ bvid, aid, outDir } = {}) {
    const ref = await refOf({ bvid, aid });
    const dir = toText(outDir) ? path.resolve(toText(outDir)) : path.join(defaultBase('download'), ref.bvid);
    return saveVideo(ref, dir);
  }

  // ── 抽帧 ──────────────────────────────────────────────────────────

  /** 解析 ffmpeg 路径（config → env → 老 surfcore → PATH），配置/环境变量指错就直接报错。 */
  function resolveFfmpegPath() {
    const fromConfig = toText(videoCfg.ffmpegPath);
    if (fromConfig) {
      if (!isFile(fromConfig)) throw new BiliError(`配置的 video.ffmpegPath 不存在：${fromConfig}`);
      return fromConfig;
    }
    const fromEnv = toText(process.env.ONEFISH_FFMPEG_PATH);
    if (fromEnv) {
      if (!isFile(fromEnv)) throw new BiliError(`环境变量 ONEFISH_FFMPEG_PATH 指向的文件不存在：${fromEnv}`);
      return fromEnv;
    }
    const legacy = legacyFfmpegPath();
    if (isFile(legacy)) return legacy;
    return 'ffmpeg';
  }

  /** 绝对路径已确认存在；裸命令名先跑一次 -version，找不到时报一句能照做的错。 */
  async function ensureFfmpeg() {
    const candidate = resolveFfmpegPath();
    if (path.isAbsolute(candidate)) return candidate;
    try {
      await execFileAsync(candidate, ['-version'], { timeoutMs: 15000 });
    } catch (error) {
      throw new BiliError(
        `找不到可用的 ffmpeg（${candidate}）：${toText(error?.message, String(error))}\n` +
          '装到 PATH 里，或在配置 video.ffmpegPath / 环境变量 ONEFISH_FFMPEG_PATH 里给完整路径。',
      );
    }
    return candidate;
  }

  async function frames({ bvid, aid, count = 9, outDir } = {}) {
    // 先解析 ffmpeg：它缺了就立刻报错，别先去下载一条大视频再失败。
    const ffmpeg = await ensureFfmpeg();
    const ref = await refOf({ bvid, aid });
    requireCid(ref);
    if (!(ref.duration > 0)) throw new BiliError(`拿不到视频时长，没法等间隔抽帧（${ref.bvid}）`);
    const wanted = Math.min(Math.max(1, toInt(count, 9)), Math.max(1, toInt(videoCfg.maxFrames, 9)));
    const dir = toText(outDir) ? path.resolve(toText(outDir)) : path.join(defaultBase('frames'), ref.bvid);
    fs.mkdirSync(dir, { recursive: true });
    log(`[video] 抽帧 ${ref.bvid}：${wanted} 张（时长 ${ref.duration}s）→ ${dir}`);

    const source = await saveVideo(ref, dir);
    const framesDir = path.join(dir, 'frames');
    // 清掉上次抽的帧：ffmpeg 序列输入会把残留帧也拼进九宫格。
    fs.rmSync(framesDir, { recursive: true, force: true });
    fs.mkdirSync(framesDir, { recursive: true });

    // 每格取中点，等间隔铺满全片（两侧不留空白）。
    const times = Array.from({ length: wanted }, (_, index) => ((index + 0.5) * ref.duration) / wanted);
    const produced = [];
    for (let index = 0; index < times.length; index += 1) {
      const file = path.join(framesDir, `f${String(index).padStart(2, '0')}.jpg`);
      try {
        await execFileAsync(ffmpeg, [
          '-y', '-loglevel', 'error',
          '-ss', times[index].toFixed(2),
          '-i', source.file,
          '-frames:v', '1', '-an', '-q:v', '3',
          file,
        ]);
      } catch (error) {
        log(`[video] 第 ${index + 1} 帧抽失败，跳过：${toText(error?.message, String(error))}`);
      }
      if (isFile(file)) produced.push(file);
    }
    if (!produced.length) throw new BiliError(`ffmpeg 一帧都没抽出来（${ref.bvid}），视频可能加密或解码失败`);

    // 中间有失败时编号有缺口，而 `-i f%02d.jpg` 要求从 0 连续，这里重排一遍。
    const images = produced.map((file, index) => {
      const target = path.join(framesDir, `f${String(index).padStart(2, '0')}.jpg`);
      if (file !== target) fs.renameSync(file, target);
      return path.resolve(target);
    });

    const cols = Math.ceil(Math.sqrt(images.length));
    const rows = Math.ceil(images.length / cols);
    const grid = path.resolve(dir, `${ref.bvid}-grid.jpg`);
    await execFileAsync(ffmpeg, [
      '-y', '-loglevel', 'error',
      '-framerate', '1',
      '-i', path.join(framesDir, 'f%02d.jpg'),
      '-vf', `scale=480:-1,tile=${cols}x${rows}`,
      '-frames:v', '1', '-q:v', '3',
      grid,
    ]);
    if (!isFile(grid)) throw new BiliError('ffmpeg 没生成九宫格图');

    log(`[video] 抽帧完成：${images.length} 张 + 拼图 ${grid}`);
    return {
      dir: path.resolve(dir),
      images,
      grid,
      title: ref.title,
      duration: ref.duration,
    };
  }

  return {
    info,
    subtitles,
    comments,
    playUrl,
    download,
    frames,
  };
}
