# OneFish Core

最小可运行核心：人格 / 记忆 / 日会话生命周期，直接在 DSH 原生对话窗口里使用。

## 装什么

- DSH 插件宿主：`onefish-core`
- MCP server：`lib/mcp-core.mjs`（memory_* / memory_archive_search / persona_get / session_get）
- agent preset：`presets/onefish-core.patch.yml`

## 不装什么

QQ、B站、桌宠、语音、桥接、SnowLuma 都不参与；它们后续作为 `components/*` 可选组件接入。

## 目录边界

```text
lib/core/
├─ domain/        # 纯规则：日切 / 摘要 / 配置归一化
├─ application/   # 用例：人格 / 记忆 / 日会话 / 开机包
├─ adapters/
│  ├─ fs/         # 文件存储
│  └─ dsh/        # DSH session / workspace
└─ index.js       # 组合根 / 公开出口
```

组件只应使用 `lib/core/index.js` 或后续公开 API，不要直接 import domain/application/adapters。

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

## 数据

- 核心数据根：`~/.dsh/onefish-core`（独立目录，**不读取旧 SurfCore 数据**）。
- 需要指定别处：设置 `ONEFISH_CORE_HOME`。
- 人格：默认内置中性人格；在设置页保存后会写到 `~/.dsh/onefish-core/core/persona.md`；不自动继承旧 `roles/` 或旧角色包。
- 记忆：`~/.dsh/onefish-core/memory-v2/space/entries.jsonl`（首次写入时创建）。
- 日会话索引：`~/.dsh/onefish-core/core/session-index.json`（只存 day → sessionId，不存消息）。
- 全量档案：`~/.dsh/onefish-core/archive/days/YYYY-MM-DD.jsonl`。
- 日摘要：`~/.dsh/onefish-core/archive/digests/YYYY-MM-DD.md`。

## 会话生命周期

DSH 拥有消息历史、上下文和会话 UI；Core 只管理日会话：

- 逻辑日默认 **04:00**（可在 `core/config.json` 改 `rolloverHour`）；
- 日会话放在专用 DSH workspace：默认标题 `onefish`，路径 `~/.dsh/OneFish`；
- 当天首次需要会话时创建 `onefish-core` preset 的 DSH session；
- 创建后注入**开机包**（`developer/message`，不产生 user turn）：core 全量记忆、人格卡、active 记忆、昨日摘要/近期档案、DSH 使用说明；
- 设置页可预览开机包；接口 `GET /dsh-onefish-core/api/session/bootpack`；
- 换日后封存旧会话，并异步整理进全量档案；
- 整理失败保留 pending，下次启动重试；
- “回收”使用 DSH archive，不删除历史。

> DSH 会隐藏“空白会话”（还没有 turn 的 session）。今天的日会话已经在 `onefish` 工作区预建，
> 打开该工作区点“新建对话”就会复用这条会话；它不会作为空行出现在普通会话列表里。
