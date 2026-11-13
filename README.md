# OneFish

OneFish 独立项目：和重构前的 SurfCore 仓库分开，只保留最小核心。

```text
OneFish/
└─ package/
   └─ onefish-core/        # DSH 插件包（自包含）
      ├─ lib/
      │  ├─ index.js       # DSH 宿主
      │  ├─ client.js      # 设置页
      │  ├─ mcp-core.mjs   # MCP server
      │  ├─ core/          # 人格 / 记忆 / 日会话生命周期
      │  └─ dsh/           # DSH session adapter
      ├─ presets/
      ├─ scripts/setup-dsh.mjs
      ├─ test/
      └─ package.json
```

## 架构决策

- [ADR-0001：Core is DSH-first](docs/adr/0001-core-is-dsh-first.md)
- [ADR-0002：会话运行时归 DSH，生命周期归 Core](docs/adr/0002-session-ownership.md)
- [ADR-0003：全量记忆与 memory-space 分层，日终整理](docs/adr/0003-memory-layers-and-consolidation.md)

## 安装 / 注册

```powershell
cd $env:USERPROFILE\.dsh\OneFish\package\onefish-core
npm install
npm run setup
# 完全退出 DSH 再打开
```

## 数据

核心数据独立在 `~/.dsh/onefish-core`，不读取旧 `~/.dsh/surfcore` 的人格/记忆。

- 人格：`~/.dsh/onefish-core/core/persona.md`
- 记忆：`~/.dsh/onefish-core/memory-v2/space/entries.jsonl`
- 日会话索引：`~/.dsh/onefish-core/core/session-index.json`（只存 day → sessionId）
- 全量档案：`~/.dsh/onefish-core/archive/days/*.jsonl`
- 日摘要：`~/.dsh/onefish-core/archive/digests/*.md`

## 会话生命周期

- **消息历史、上下文、会话 UI 归 DSH**；
- Core 只负责：每天新建日会话、封存旧日会话、把旧会话整理进全量档案；
- 逻辑日默认 **04:00**；
- “回收”是归档/隐藏，不删除历史。

## 开发

```powershell
cd $env:USERPROFILE\.dsh\OneFish\package\onefish-core
npm test
```

当前只包含 Core MVP：人格 / 记忆 / DSH 对话窗口。QQ、B站、桌宠后续作为可选组件接入。
