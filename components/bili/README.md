# onefish-component-bili

OneFish 的 B站 频道组件（第一版只接三件事：**看视频 / 私信 / 评论**）。

- 入站：轮询私信会话 + 评论收件箱（回复我的 / @我的），有新东西才送进 OneFish Core 日会话；
- 出站：本组件自己的 `bili_*` MCP 工具（发私信、回评论、刷首页/热门、看视频抽帧、拉字幕/热评）；
- 凭据：默认继续读旧 surfcore 的 `~/.dsh/surfcore/bili/credentials.json`，不复制进仓库、不打印、不进 prompt。

## 1. 目标字段

| 字段 | 值 |
| --- | --- |
| 组件 id | `bili` |
| delivery | `tool`（`channel.outbound: 'tool'`） |
| channelKey | 私信 `dm:<mid>`；评论 `comment:<oid>` |
| MCP server | `onefish-bili`，工具名 `mcp__onefish-bili__bili_*` |
| 当前范围 | 私信收发、评论收件箱/评论区/回复、看视频（信息/字幕/热评/抽帧九宫格） |

## 2. 边界

> Component 负责频道 IO 和频道工具；Core 负责人格、记忆、日会话、prompt broker。

- 只通过 `ctx.onefishCore.components.register` 注册，只用 `scope.session.submit` / `scope.stateDir` / `scope.config`；
- 不 import `onefish-core/lib/core/**`，不调 `sessionController`，不读 Core 私有配置；
- 组件状态只写 `scope.stateDir`；
- 凭据只读，不写日志、不进 prompt、不落仓库。

### 评论规矩（2026-11-19 主人定）

- 顶楼评论必须 @ 主人：`outbound.mentionOwner` 默认 `true`，正文没有 `@<owner.name>` 时自动补在开头；楼中楼回复不自动 @；
- 不是每条视频都评论——只在觉得有趣/有必要时评；
- 回复别人的评论最多两三条，不水。

## 3. MCP 工具

| 工具 | 作用 |
| --- | --- |
| `bili_status` | 只读诊断：凭据是否可用、登录账号、私信未读、配置摘要 |
| `bili_dm_sessions` | 私信会话列表（谁找过我、最后一句、未读、时间） |
| `bili_dm_messages` | 某个会话的历史消息 |
| `bili_dm_send` | 发私信（主人不限；别人只能回，48 小时内） |
| `bili_comment_inbox` | 评论收件箱（回复我的 / @我的），尽量回读楼层拿正文 |
| `bili_comment_thread` | 回读某个评论楼的回复 |
| `bili_comment_list` | 评论区列表（视频 aid / 动态 oid） |
| `bili_comment_reply` | 发评论 / 二级回复 |
| `bili_feed` | 刷：首页推荐（WBI 签名）/ 热门 / 排行榜，非稿件条目跳过 |
| `bili_video_info` | 视频信息（标题/简介/UP/数据/aid/cid） |
| `bili_video_subtitles` | 字幕全文（优先中文 / AI 字幕） |
| `bili_video_comments` | 视频热评 |
| `bili_video_frames` | 下载 + 抽帧九宫格，返回图片路径给 `read_image` 看 |

## 4. 配置

组件自管配置：`<stateDir>/config.json`（默认 `~/.dsh/onefish-data/components/bili/config.json`）。

```jsonc
{
  "credentialsFile": "",            // 留空：stateDir/credentials.json -> ~/.dsh/surfcore/bili/credentials.json
  "owner": { "mid": "", "name": "主人" },  // 主人 mid：私信不限；别人只能回
  "poll": { "enabled": true, "intervalSec": 120, "dm": true, "comment": true },
  "outbound": { "maxDmLength": 300, "maxCommentLength": 300, "allowStrangerDm": true },
  "video": { "ffmpegPath": "", "workDir": "", "maxFrames": 9 },
  "dedupeWindow": 2000
}
```

```powershell
$env:ONEFISH_COMPONENT_STATE_DIR = "$HOME\.dsh\onefish-data\components\bili"
$env:ONEFISH_COMPONENT_CONFIG_FILE = "$env:ONEFISH_COMPONENT_STATE_DIR\config.json"
npm run settings -- show
npm run settings -- set-json '{"owner":{"mid":"123456"}}'
```

`ffmpegPath` 留空时按顺序找：env `ONEFISH_FFMPEG_PATH` → `~/.dsh/surfcore/bili/bin/ffmpeg.exe` → `ffmpeg`。

## 5. 状态

目录：`~/.dsh/onefish-data/components/bili/`

| 文件 | 内容 |
| --- | --- |
| `config.json` | 组件配置（宿主 / MCP 共用） |
| `state.json` | 去重窗口 + 每会话/收件箱水位（原子写，损坏时备份） |
| `state.corrupt-<时间戳>.json` | 状态损坏时的备份 |

首轮轮询只记基线，不把历史消息倒进会话；之后只提交水位之后的新消息。评论以 `(kind, id)` 去重，私信以 `(mid, ts)` 去重。

## 6. 安装

```powershell
cd $env:USERPROFILE\.dsh\OneFish\components\bili
npm install
npm test
npm run setup -- desktop --dry-run   # 先看计划
npm run setup -- desktop
# 完全退出 DSH，再打开
```

setup 会幂等地：链接到 `~/.dsh/plugins/onefish-component-bili`、profile `node_modules` 建链接、profile `package.json` 加 dependency+bundle、profile `cordis.patch.yml` 写 `mcp-onefish-bili`，并从旧 `bili.config.json` 取 `owner.mid/name` 做首份配置。

## 7. 已知限制（第一版）

- 私信只拉会话列表 + 最近消息/历史文本，不处理图片/表情/视频卡片正文；
- 私信只能「回」陌生人，不能主动开新会话；系统/官方号不回；
- 评论区只支持视频（type=1）与动态（11/17），直播弹幕/收藏/点赞/鱼群保护/额度账本还没搬；
- 抽帧依赖 ffmpeg；没装时 `bili_video_frames` 会明确报错；
- 出站身份闸（不泄露主人/别人 mid、QQ 号）还没搬，只有长度和对象校验；
- 评论发送可能触发风控，失败不会自动重试。
