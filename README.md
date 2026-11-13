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
      │  └─ core/          # 人格 / 记忆 / 统一会话
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
- 会话：`~/.dsh/onefish-core/core/sessions.json`

## 开发

```powershell
cd $env:USERPROFILE\.dsh\OneFish\package\onefish-core
npm test
```

当前只包含 Core MVP：人格 / 记忆 / DSH 对话窗口。QQ、B站、桌宠后续作为可选组件接入。
