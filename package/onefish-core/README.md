# OneFish Core

最小可运行核心：人格 / 记忆 / 统一会话，直接在 DSH 原生对话窗口里使用。

## 装什么

- DSH 插件宿主：`onefish-core`
- MCP server：`lib/mcp-core.mjs`（memory_* / persona_get / session_get）
- agent preset：`presets/onefish-core.patch.yml`

## 不装什么

QQ、B站、桌宠、语音、桥接、SnowLuma 都不参与；它们后续作为 `components/*` 可选组件接入。

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
- 会话：`~/.dsh/onefish-core/core/sessions.json`。
