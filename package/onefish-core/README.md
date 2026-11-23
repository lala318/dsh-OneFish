# OneFish Core

最小可运行核心：人格 / 记忆 / 日会话生命周期，直接在 DSH 原生对话窗口里使用。

## 装什么

- DSH 插件宿主：`onefish-core`
- MCP server：`lib/mcp-core.mjs`（memory_* / memory_archive_search / memory_maintain / idle_* / persona_get / session_get）
- agent preset：`presets/onefish-core.patch.yml`

## 不装什么

QQ、B站、桌宠、语音、桥接、SnowLuma 都不参与；它们后续作为 `components/*` 可选组件接入。

## 目录边界

```text
lib/core/
├─ domain/        # 纯规则：日切 / 摘要 / 配置归一化
├─ application/   # 用例：人格 / 记忆 / 日会话 / 开机包（不碰 fs）
├─ adapters/
│  ├─ fs/         # 文件存储 + persona/memory store
│  └─ dsh/        # DSH session / workspace
└─ index.js       # 组合根 / 公开出口
```

组件只应使用 `.`（`lib/core/index.js`）或后续公开 API，不要直接 import domain/application/adapters。

## 安装

```powershell
cd $env:USERPROFILE\.dsh\OneFish\package\onefish-core
npm install
npm run setup
# 完全退出 DSH 再打开
```

然后在 DSH 对话窗口选择 `OneFish Core` preset，或直接开始对话。

> 这个目录是**自包含**的：核心源码在 `lib/core/`，MCP 依赖装在本包 `node_modules/`，
> 不依赖重构前的 `surfcore-repo`。旧仓库只保留作历史/回退。

## 装完跑不通：先体检

```powershell
npm run doctor          # 只读检查，不动数据
npm run doctor -- --init   # 顺手补人格卡和 config.json
```

查的是：Node 版本、数据目录可写、配置文件、人格卡、记忆条数、**向量模型（真的去加载一次，不是看懒加载状态）**、档案天数，以及新装最容易漏的——插件有没有注册进 profile（`package.json` 的 dependency/bundles、`node_modules` 链接、`cordis.patch.yml` 里的 `mcp-onefish-core`）。每项给 `✔ / ! / ✘` 和一句下一步；有 `✘` 时退出码为 1。

设置页「自检」页签查的是同一批东西（不含 profile 注册），适合已经打开 DSH 的时候看。

常见对应关系：

| 现象 | 多半是 | 怎么办 |
| --- | --- | --- |
| 设置里根本没出现 OneFish | 插件没注册进 profile | `npm run doctor` 看 profile / link / mcp 三项，跑 `npm run setup`，然后**完全退出 DSH** 再开 |
| 页签空白或报「没加载成功」 | 客户端 bundle 还是旧的 | 重启 DSH（刷新页面不够） |
| 会话页一直「还没有日会话」 | 没拿到 DSH sessionController | 确认插件在 DSH 里加载；`npm run doctor` 里看宿主 |
| 召回不命中 | 向量模型没装，退化成词面匹配 | 能跑，但弱；要装模型就配 `embedding.runtimeDir/modelDir` |
| 保存配置后行为没变 | 只有 `idleClock` 立即生效 | 其余字段重启插件 |

## 新装一台，怎么自己跑起来

设置页「OneFish」→「自检」→ **一键初始化**（或 `POST /dsh-onefish-core/api/bootstrap`）。它会：

1. 补齐数据目录；
2. 没有人格卡时写一版**空壳**（不会覆盖已有的）；
3. 没有 `config.json` 时落一份默认配置；
4. 检查向量模型是否就绪（不会替你下载）；
5. 建今天的日会话（需要 DSH 的 sessionController；没有就如实报失败并给提示）。

跑完看「自检」页：每一项都有 `正常 / 注意 / 异常` 和一句下一步提示。能自动做的都做了，剩下的必须人来做（写人格、装模型、给权限），不会假装成功。

## 设置页

| 页签 | 能做什么 |
| --- | --- |
| 概览 | 数据目录 / 人格 / 会话 / 记忆层级 / 已登记组件；没配好时顶部出现「一键初始化」 |
| 人格 | 切换角色、新建角色；编辑并保存人格卡（下一轮生效），有未保存改动提示 |
| 记忆 | 按内容/层级搜索、写入、软删除、手动跑一次维护 |
| 配置 | 基础、开机包与人格上限、整理与时间戳、每轮召回、向量模型；保存后逐项列出被修正的字段 |
| 空闲钟 | 启用、最小空闲、概率尺度/形状、冷却、检查间隔；预览 prompt、立即触发 |
| 会话 | 预览开机包、新建今日会话、按日期整理、让会话退役 |
| 组件 | 已登记组件的状态 / 版本 / 能力 / 启动错误（只读，启停归 DSH 加载流程） |
| 自检 | 环境检查清单 + 一键初始化结果 |

配置写入 `<数据根>/config.json`。**保存后能立即生效的只有 `idleClock`**（它有自己的 configure），其余字段由各服务启动时快照，需要重启插件；保存结果的提示里会分开写明。

> **token / 预算不在 core**：core 不计费、不记账（旧 SurfCore 那套 token 管理没有搬过来）。要按天限额度，那是宿主或组件侧的事，这里不假装有。

接口：

```text
GET  /dsh-onefish-core/api/config        # 当前配置 + 默认值 + liveKeys
POST /dsh-onefish-core/api/config        # { config: {...} } 归一化落盘，返回 warnings
GET  /dsh-onefish-core/api/diagnostics   # 自检清单
POST /dsh-onefish-core/api/bootstrap     # 一键初始化
GET  /dsh-onefish-core/api/characters    # 角色列表 + 当前角色
POST /dsh-onefish-core/api/characters    # { id, name } 新建角色（空壳人格）
POST /dsh-onefish-core/api/characters/switch  # { id } 只改当前角色
```

写接口都要求本机回环 Host、同源 Origin、`application/json`。

## 数据

- 核心数据根：`~/.dsh/onefish-data`（独立目录，**不读取旧 SurfCore 数据**）。可重装的向量运行时在 `~/.dsh/cache/onefish`。
- 需要指定别处：设置 `ONEFISH_CORE_HOME`。
- 人格：默认内置中性人格；在设置页保存后会写到 `~/.dsh/onefish-data/persona.md`；角色人格在 `~/.dsh/onefish-data/characters/<角色>/persona.md`。不自动继承旧 `roles/` 或旧角色包。
- 记忆：`~/.dsh/onefish-data/characters/<角色>/memory/entries.jsonl`（首次写入时创建）。
- 记忆向量索引：`~/.dsh/onefish-data/characters/<角色>/memory/vectors/index.jsonl`（默认 bge-small-zh-v1.5 ONNX；模型不可用时自动回退本地 hash）。
- 记忆整理：模型输出 JSON ops，`memory-consolidate` 校验后落库；人工只保留删除/手动添加。
- 空闲钟状态：`~/.dsh/onefish-data/state/idle-clock.json`。
- 日会话索引：`~/.dsh/onefish-data/state/session-index.json`（只存 day → sessionId，不存消息）。
- 全量档案：`~/.dsh/onefish-data/archive/days/YYYY-MM-DD.jsonl`。
- 日摘要：`~/.dsh/onefish-data/archive/digests/YYYY-MM-DD.md`。

## 时间戳

每轮 user turn 的第一个 `step/start`，Core 通过 `developer/message` 自动注入一次 `【当前时间】`；不修改用户正文，DSH 原生窗口直接对话也不会丢时间。

配置：

```json
{ "timestamp": { "enabled": true } }
```

## 空闲钟

空闲时钟来自旧版插件，Core 侧是：

- 纯概率曲线：空闲越久越可能触发，触发后随机冷却；
- 状态持久化到 `core/idle-clock.json`；
- 默认 `enabled: false`，启用后会向当前日会话发一条主动 prompt；
- 设置页「空闲钟」可直接配置启用、最小空闲、概率尺度/形状、冷却和检查间隔，保存后立即生效并写入 `core/config.json`；
- 「立即想一次」是调试动作：只发一条 prompt，**不吃当天额度、不进冷却**（`state.lastManualAt` 只作痕迹），不干扰真触发。
- 可配 `minIdleMs`、`scaleHours`、`shape`、`cooldownMinMs`、`cooldownMaxMs`。

```json
{
  "idleClock": {
    "enabled": true,
    "minIdleMs": 600000,
    "scaleHours": 3,
    "shape": 2
  }
}
```

接口：`GET /dsh-onefish-core/api/idle/status`、`GET /idle/preview`、`POST /idle/run`、`GET|POST /idle/config`。
MCP：`idle_status`、`idle_preview`。

## 记忆维护

- **遗忘曲线**：按重要度、使用次数、层级计算 stability / retention；low-retention active 记忆在主动注入时被跳过。
- **语义向量**：默认加载 `~/.dsh/cache/onefish/runtime/onnx-embed/model` 的 bge-small-zh-v1.5；`memory_search` 做 lexical + cosine 混合检索。模型/onnxruntime 不可用时自动回退本地 hash，并写入索引 model 标记。
- **夜间模型整理**：日终 consolidation 后，Core 通过独立 DSH 会话让模型输出 `{"ops":[...]}`；`memory-consolidate` 校验后自动落库，人工只保留删除/手动添加，不逐条审计。
- **矛盾/过期**：`supersede` 用新事实替代旧事实；旧条目保留在 `meta`/`superseded`，不再进入默认检索和注入。
- 手动/调试入口：`memory_maintain`、`memory_consolidation_prompt`、`memory_consolidate_apply`、`memory_supersede` MCP。

embedding 配置：

```json
{
  "embedding": {
    "runtimeDir": "C:/Users/you/.dsh/cache/onefish/runtime/onnx-embed",
    "modelDir": "C:/Users/you/.dsh/cache/onefish/runtime/onnx-embed/model"
  }
}
```

模型目录需要 `model.onnx`、`vocab.txt`、`tokenizer_config.json`；runtime 目录需要可用的 `onnxruntime-node`。未配置时按默认路径自动查找，仍失败则回退 hash。


## 会话生命周期

DSH 拥有消息历史、上下文和会话 UI；Core 只管理日会话：

- 逻辑日默认 **04:00**（可在 `core/config.json` 改 `rolloverHour`）；
- 日会话放在专用 DSH workspace：默认标题 `onefish`，路径 `~/.dsh/OneFish`；
- 当天首次需要会话时创建 `onefish-core` preset 的 DSH session；
- 创建后准备**开机包**，在首个 open turn/step 通过 `developer/message` 注入（不产生 user turn）：core 全量记忆、人格卡、active 记忆、昨日摘要/近期档案、DSH 使用说明；
- 设置页可预览开机包；接口 `GET /dsh-onefish-core/api/session/bootpack`；
- 换日后封存旧会话，并异步整理进全量档案；
- 整理失败保留 pending，下次启动重试；
- “回收”使用 DSH archive，不删除历史。

> DSH 会隐藏“空白会话”（还没有 turn 的 session）。今天的日会话已经在 `onefish` 工作区预建，
> 打开该工作区点“新建对话”就会复用这条会话；它不会作为空行出现在普通会话列表里。
