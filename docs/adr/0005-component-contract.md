# ADR-0005: Component Contract v1

- 状态：Accepted
- 日期：2026-11-13
- 相关：ADR-0001、ADR-0002

## 背景

Core 已经能独立运行：人格、记忆、日会话、开机包、归档。下一步要接 QQ / B站 / 桌宠，但当前没有组件边界：

- 没有 manifest / 生命周期；
- 没有 Core 对组件的公开 API；
- 没有入站/出站消息协议；
- 没有组件状态、配置、失败隔离；
- 组件可能直接 import core 内部，或直接调 DSH session。

先定契约，再接真实频道。

## 决策

### 1. 组件是独立 DSH bundle

```text
OneFish/
├─ package/onefish-core/
├─ packages/component-sdk/
└─ components/
   ├─ echo/
   ├─ bili/
   ├─ pet/
   └─ qq/
```

- 组件有自己的 `package.json` / `dsh.bundle.patch`；
- `inject: ['onefishCore']`；
- 不 import `onefish-core/lib/core/*`；
- 不调用 `/dsh-onefish-core/api/*`（那是设置页接口）；
- 可以有自己的 MCP server 和 DSH 工具。

### 2. Core 暴露 scoped handle

`ctx.onefishCore` 只负责注册；注册后每个组件拿到自己的 handle：

```js
const handle = ctx.onefishCore.components.register({
  manifest,
  async start(scope) {},
  async stop() {},
  async health() {},
});

handle.id;
handle.session.ensureToday();
handle.session.current();
handle.session.submit(envelope);
handle.session.onOutbound(handler);
handle.persona.get();
handle.memory.search();
handle.bootPack.preview();
handle.stateDir;
handle.config;
```

`componentId` 由 Core 自动补，组件不能伪造。

### 3. Manifest

```js
{
  manifestVersion: 1,
  id: 'bili',
  name: 'Bilibili',
  version: '0.1.0',
  apiVersion: 1,
  core: '^0.1.0',
  capabilities: {
    channel: { inbound: true, outbound: 'auto' },
    tools: false,
    jobs: false,
    context: true,
  },
  state: true,
  configSchema: {}
}
```

`channel.outbound`：

- `auto`：Core 在 `turn/end` 把 assistant 文本交给组件，组件负责发送；B站/桌宠；
- `tool`：模型调用组件自己的 MCP 工具发送，Core 不自动转发；QQ；
- `none`：只入站。

### 4. 消息信封

Inbound：

```js
{
  channelKey,
  requestId,
  messageId,
  user: { id, name },
  text,
  attachments,
  replyTo,
  receivedAt,
  meta
}
```

Outbound：

```js
{
  componentId,
  channelKey,
  requestId,
  turnId,
  kind: 'assistant' | 'error',
  text,
  replyTo,
  at
}
```

### 5. Core 是唯一 prompt/reply broker

组件不直接调用 DSH `sessionController.prompt`。

- Core 负责 `ensureToday()`、FIFO 队列、prompt 包装；
- `turn/start` 绑定当前请求；
- `assistant/message` 累积文本；
- `turn/end` 发出 outbound；
- `outbound: auto` 才自动发给组件；
- DSH 窗口里用户自己发起的 turn 不进入组件队列；
- 同一日会话同一时间只允许一个 active turn。

### 6. 状态和配置

- 组件状态：`~/.dsh/onefish-core/components/<id>/`
- 组件配置：`~/.dsh/onefish-core/core/config.json` 的 `components.<id>`
- 组件不能读写 core 的 persona / memory / session-index。

### 7. 版本和隔离

- `apiVersion: 1`，破坏性变更才升 2；
- `core: '^0.1.0'` 做兼容检查；
- 组件启动失败只记录 health，不阻塞 core；
- 组件可禁用；
- 组件 outbound handler 抛错不传播给其他组件。

## 实现状态

| 部分 | 状态 |
| --- | --- |
| `packages/component-sdk` | 已实现 manifest / envelope 校验 |
| `components/echo` | 已实现，作为契约假组件 |
| Core component registry | 已实现 manifest / lifecycle / scoped handle |
| `onefishCore` Cordis service | 已实现 `ctx.provide` |
| DSH component broker | 已实现 FIFO prompt / turn 聚合 / outbound |
| echo 安装到 live DSH | 未安装；先用单元测试验证 |
| QQ/B站/桌宠 | 未接入 |

当前 broker 是 MVP：

- FIFO 假设 DSH 按顺序处理 core 提交的 prompt；
- DSH 窗口用户自己发起的 turn 通过 active turn 检测忽略，但不做严格来源标记；
- 流式输出先按 `turn/end` 批量发出，不逐 token 推送。

## 后果

### 正面

- 组件不需要碰 core 内部；
- 入站/出站、状态、配置、版本都有明确契约；
- QQ 的 tool 模式和 B站/桌宠的 auto 模式可共存；
- 可以先接一个假组件验证，再接真实频道。

### 负面 / 风险

- broker 的 turn 归属依赖 DSH 事件顺序，复杂并发需要进一步加 request 标记；
- 组件仍可能违反契约直接 import，需要静态检查；
- Core 和组件都要跟随 DSH 内部 session 接口变化；
- `tool` 模式依赖模型正确调用组件工具。

## 备选方案

### A. 组件直接调 DSH sessionController（否决）

队列、回复路由、错误隔离会散到每个组件。

### B. 每个频道独立日会话（否决）

破坏“每天一个共享日会话”的设定；记忆统一但上下文不统一。

### C. 组件放在 core 包内（否决）

无法独立安装/禁用，失败隔离和版本边界都会变差。

## 验收标准

- `echo` 能注册、start、stop、health；
- `echo.submit()` 能进入 core 队列；
- `turn/end` 后 `outbound:auto` 组件收到文本；
- `tool` 模式组件不会自动收到转发；
- 组件状态在 `components/<id>/`；
- 组件启动失败不影响 core；
- 组件不 import core 内部；
- Core 仍能在无组件时正常对话。
