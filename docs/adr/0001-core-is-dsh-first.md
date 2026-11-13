# ADR-0001: Core is DSH-first

- 状态：Accepted
- 日期：2026-11-13
- 相关：ADR-0002、ADR-0003

## 背景

OneFish 最初尝试把核心设计成可脱离 DSH 独立存在的 `packages/core`，由 DSH 插件、QQ、B站、桌宠等不同宿主复用。

实际约束是：

1. DSH 是唯一真实宿主。没有第二个宿主，也没有独立的模型调用、会话上下文、MCP 工具层。
2. QQ / B站 / 桌宠接入后，本身也是 DSH 侧的组件，依赖 DSH 提供 MCP 工具和会话上下文。
3. 把 Core 做成独立运行时，会重复实现 DSH 已经提供的会话、工具、设置、事件能力，并引入打包/引用问题。
4. DSH 不可能降到和频道组件相同的层级；它是宿主，组件是适配器。

因此需要明确：OneFish Core 到底是一个独立平台，还是 DSH 插件内核。

## 决策

**OneFish Core 是 DSH-first 的插件内核，不是独立运行时。**

具体含义：

- `onefish-core` 是一个 DSH bundle / 插件包；
- DSH 是宿主，负责会话运行时、模型调用、MCP 传输、设置、事件；
- Core 只负责 OneFish 自己的领域能力：人格、记忆、日会话生命周期、全量记忆整理；
- 不再维护“可脱离 DSH 独立运行”的 `@onefish/core` 包；
- Core 的领域模块内部尽量不 import DSH，但这是为了可测试和边界清晰，不是为了将来脱离 DSH；
- 所有 DSH 耦合集中在 host / adapter 层；
- 频道组件（QQ/B站/桌宠）依赖 DSH + OneFish 公开 API，不直接 import core 内部文件。

目标层级：

```text
DSH（宿主 / runtime）
└─ OneFish 插件（core kernel）
   ├─ domain：persona / memory / daily-session
   ├─ adapters：DSH session / tools / settings
   └─ public API
        ↑
components：qq / bili / pet（可选频道组件）
```

## 后果

### 正面

- 不再为不存在的第二个宿主付抽象成本；
- 直接使用 DSH 的会话、工具、设置、事件，不重复造轮子；
- 插件包可以自包含，避免“core 不在 files 里”的打包问题；
- 组件层级清晰：组件不依赖 core 内部，只依赖公开 API。

### 负面

- Core 与 DSH 版本存在耦合，需要 adapter 层和兼容性检查；
- Core 不能独立运行，单测需要 DSH 的最小 fake 或测试宿主；
- 以后如果真的出现第二个宿主，需要重新抽离，而不是现在预留。

## 备选方案

### A. 独立 Core 运行时（否决）

为尚未存在的第二宿主维护完整运行时边界，成本高，且会与 DSH 能力重复。

### B. Core 与 QQ/B站/桌宠平级（否决）

错误地把插件内核和频道适配器放在同一层，导致依赖方向混乱。

### C. 所有 Core 代码直接 import DSH（部分否决）

部署上 Core 依赖 DSH 没问题，但领域逻辑完全不隔离会让单测和 DSH 升级适配变困难。保留 host/adapter 边界，但不再追求独立运行。

## 验收标准

- 不安装任何频道组件时，OneFish Core 能在 DSH 中正常对话、读写人格/记忆；
- `onefish-core` 可独立安装/复制，不依赖旧 SurfCore 仓库；
- 频道组件不需要 import `onefish-core/lib/core/*`；
- DSH 升级导致 API 变化时，只需改 adapter 层。
