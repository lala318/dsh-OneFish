# OneFish 组件接入规范

- 版本：v1
- 对应 ADR：[ADR-0005 Component Contract v1](../adr/0005-component-contract.md)
- 参考实现：[components/echo](../../components/echo)
- 契约包：[packages/component-sdk](../../packages/component-sdk)

## 1. 适用范围

本文规定一个可选频道组件如何接入 OneFish Core，包括：

- QQ
- B站
- 桌宠
- 未来的其它频道/工具组件

组件是**独立 DSH bundle**，不是 `onefish-core` 的子目录，也不是 core 内部模块。

## 2. 边界一句话

> **Component 负责频道 IO 和频道工具；Core 负责人格、记忆、日会话、prompt/reply broker。**

组件只能通过 `ctx.onefishCore` 的 scoped handle 使用 Core，不能 import core 内部。

## 3. 目录和包结构

```text
OneFish/
├─ package/onefish-core/
├─ packages/component-sdk/
└─ components/
   ├─ echo/          # 契约测试组件
   ├─ bili/
   ├─ pet/
   └─ qq/
```

单个组件：

```text
components/<id>/
├─ package.json
├─ cordis.patch.yml      # DSH bundle patch
├─ lib/
│  ├─ index.js           # manifest + lifecycle + apply
│  └─ mcp.mjs            # 可选：自己的 MCP server
├─ test/
└─ README.md
```

组件的 `package.json` 必须声明 DSH bundle patch：

```json
{
  "name": "onefish-component-bili",
  "type": "module",
  "dependencies": {
    "@onefish/component-sdk": "file:../../packages/component-sdk"
  },
  "dsh": {
    "bundle": {
      "patch": ["./cordis.patch.yml"]
    }
  }
}
```

## 4. 接入步骤

### 4.1 声明 DSH 依赖

```js
export const name = 'onefish-component-bili';
export const inject = ['onefishCore'];
```

`onefishCore` 由 OneFish Core 插件提供。组件必须等它可用后再注册。

### 4.2 定义 manifest

```js
import { validateManifest } from '@onefish/component-sdk';

export const MANIFEST = validateManifest({
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
});
```

### 4.3 实现生命周期

```js
let scope = null;
let off = null;

const component = {
  manifest: MANIFEST,

  async start(nextScope) {
    scope = nextScope;
    off = scope.session.onOutbound((event) => {
      // auto 模式：把 event.text 发给频道
    });
  },

  async stop() {
    off?.();
    off = null;
    scope = null;
  },

  async health() {
    return { id: MANIFEST.id, status: scope ? 'running' : 'stopped' };
  },

  // 可选：给这条入站消息加频道上下文
  renderPrompt(envelope) {
    return `【频道】${envelope.channelKey}`;
  },
};
```

### 4.4 注册

```js
export async function apply(ctx) {
  return ctx.onefishCore.components.register(component);
}
```

`register` 会校验 manifest、apiVersion、core semver 和 id 唯一性。

## 5. Manifest 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `manifestVersion` | 是 | 固定 `1` |
| `id` | 是 | `[a-z][a-z0-9-]{1,39}`，全局唯一 |
| `name` | 是 | 展示名 |
| `version` | 是 | 组件 semver |
| `apiVersion` | 是 | 固定 `1` |
| `core` | 是 | Core semver range，例如 `^0.1.0` |
| `capabilities.channel` | 否 | `{ inbound, outbound }` |
| `capabilities.tools` | 否 | 是否有自己的 MCP 工具 |
| `capabilities.jobs` | 否 | 是否有定时任务 |
| `capabilities.context` | 否 | 是否实现 `renderPrompt` |
| `state` | 否 | 是否需要 `components/<id>/` 状态目录，默认 true |
| `configSchema` | 否 | 组件配置字段声明 |

`channel.outbound` 只能是：

- `auto`：Core 在 `turn/end` 把 assistant 文本交给组件发送；
- `tool`：模型调用组件自己的 MCP 工具发送，Core 不自动转发；
- `none`：只入站。

## 6. scoped handle

`start(scope)` 收到的 handle：

```js
scope.id
scope.manifest
scope.stateDir
scope.config

scope.session.ensureToday()
scope.session.current()
scope.session.submit(envelope)
scope.session.onOutbound(handler)

scope.persona.get()
scope.persona.list()
scope.persona.update(text)
scope.persona.block(opts)

scope.memory.search(query, opts)
scope.memory.add(input)
scope.memory.update(id, patch)
scope.memory.remove(id)
scope.memory.list(opts)
scope.memory.blocks()

scope.bootPack.preview()
```

规则：

- `scope.id` / `componentId` 由 Core 自动提供，组件不要自己伪造；
- `scope.config` 在 v1 是只读快照；
- `scope.stateDir` 是组件唯一可写的目录；
- 不要直接读取 core 的 `persona.md`、memory、session-index、archive。

## 7. 入站信封

组件收到频道消息时：

```js
import { createInbound } from '@onefish/component-sdk';
import { randomUUID } from 'node:crypto';

const envelope = createInbound({
  channelKey: 'bili:dynamic:123',
  requestId: randomUUID(),
  messageId: 'platform-message-id',
  user: { id: 'uid', name: '昵称' },
  text: '消息正文',
  replyTo: '可选',
  meta: {}
});

await scope.session.submit(envelope);
```

`submit` 的返回语义按 delivery 不同：

- `auto`：进入 Core 队列即返回，后续通过 outbound 交付：

```js
{ requestId, sessionId, queued: true }
```

- `tool`：等待 DSH prompt admission，成功后才返回：

```js
{ requestId, sessionId, accepted: true, queued: false }
```

`tool` admission 失败时 `submit` 会 reject。组件只有在 `submit` 成功后才能把消息记为已处理；失败必须回滚或允许重试。

### renderPrompt

`renderPrompt(envelope)` 只返回**附加块（body）**，不能替换 Core 的信封：

```js
renderPrompt(envelope) {
  return `【频道】${envelope.channelKey}`;
}
```

Core 始终负责：

```text
【频道】componentId / channelKey
【来源】componentId
【用户】...
【组件上下文】renderPrompt 的返回值
【消息】envelope.text
```

不存在 `meta.promptOwnMessage` 之类的 Core 旁路。

## 8. 出站信封

只有 `outbound: 'auto'` 的组件会收到：

```js
{
  componentId: 'bili',
  channelKey: 'bili:dynamic:123',
  requestId: '...',
  turnId: '...',
  kind: 'assistant' | 'error',
  text: '...',
  replyTo: '...',
  at: 0
}
```

MVP 在 `turn/end` 批量发出，不做逐 token 流式。

## 9. 三种交付模式

| 模式 | Core 行为 | 组件行为 | 适用 |
| --- | --- | --- | --- |
| `auto` | 收 outbound，在 turn 结束交给组件 | 直接发到频道 | B站、桌宠 |
| `tool` | 只投递入站 prompt，不自动转发 | 自己暴露 MCP 工具，模型调用工具发送 | QQ |
| `none` | 只投递入站 | 不回复 | 通知类 |

**QQ 不要用 auto**，否则会和 `qq_send_message` 双发。

## 10. 会话与并发

- 所有组件共享当天一个 DSH 日会话；
- `auto` 模式 Core 内部 FIFO：同一时间只允许一个 active turn；
- `tool` 模式 Core 只按顺序等待 DSH prompt admission，不等待 turn/end；
- `submit` 可能排队，组件不要假设立即开始；
- 一个 `requestId` 只能对应一次提交；
- `tool` 模式组件必须自己保证工具调用幂等，Core 不替它去重；
- DSH 窗口里用户自己发起的 turn 不进入组件队列。

## 11. 状态和配置

### 状态

```text
~/.dsh/onefish-core/components/<id>/
```

组件只能写 `scope.stateDir`，建议：

- 原子写；
- 写前备份；
- 不要把 token 明文写进日志；
- 状态损坏时降级而不是覆盖。

### 配置

v1 的 `scope.config` 是只读快照，来自：

```text
~/.dsh/onefish-core/core/config.json
  components.<id>
```

v1 Core **不提供组件设置页**。组件自己管理配置/设置 UI；需要写配置时由组件自己的安装/配置流程处理，不要直接改 `config.json`。

MCP 进程拿不到 scoped handle 时，只能使用 Core/安装脚本传入的 opaque 路径：

```text
ONEFISH_COMPONENT_STATE_DIR
ONEFISH_COMPONENT_CONFIG_FILE
```

不要自己推导 Core home，也不要默认读 `core/config.json`；缺失时 fail closed。

## 12. 版本和隔离

- `apiVersion: 1`；
- `core: '^0.1.0'`；
- `manifestVersion: 1`；
- 组件 id 不能重复；
- 组件 `start` 抛错只记 health，不影响 Core；
- 组件 outbound handler 抛错不传播给其他组件；
- 组件可以停用，停用后 Core 正常。

## 13. 组件自己的 MCP 工具

组件需要模型操作频道时（尤其 QQ）：

- 自己的 MCP server 放在组件包内；
- MCP 配置由组件自己的 DSH patch 或安装流程负责；
- 不要把 QQ 工具注册进 Core；
- 工具必须是组件命名空间（例如 `qq_*`），不要和 Core 的 `memory_*` 混在一起；
- 工具参数里的 token 不要写进日志。

## 14. 测试要求

组件提交前至少要有：

1. manifest 校验测试；
2. `start / stop / health` 测试；
3. `submit` 信封测试；
4. `outbound:auto` 收到 turn 结束文本；
5. `outbound:tool` 不自动收到转发；
6. 状态目录写入/恢复测试；
7. 组件禁用时 Core 正常；
8. 组件启动失败不影响 Core。

参考 `components/echo/test/echo.test.mjs`。

## 15. 禁止事项

- ❌ `import '../../onefish-core/lib/core/...'`
- ❌ 直接调用 `ctx.sessionController.prompt`
- ❌ 直接调用 `/dsh-onefish-core/api/*`
- ❌ 读写 core 的 persona / memory / session-index / archive
- ❌ 自己伪造 `componentId`
- ❌ `tool` 模式又依赖 Core 自动转发
- ❌ 在日志里打印 token、cookie、完整用户隐私

## 16. 三个真实组件的建议

### B站

- `outbound: 'auto'`
- 组件维护游标/去重状态
- `renderPrompt` 加动态/视频/评论上下文
- 先做单向（通知/评论回复），再做主动动态

### 桌宠

- `outbound: 'auto'`
- 主要用 `scope.session.submit` 和 outbound 文本
- 不写 core 状态，只写自己的 `stateDir`

### QQ

- `outbound: 'tool'`
- 组件自己的 MCP server 暴露 `qq_*` 工具
- Core 只负责把 QQ 入站消息送进日会话
- 必须处理 token、白名单、消息幂等、发送失败重试

## 17. 接入验收清单

- [ ] manifest 通过 SDK 校验
- [ ] `inject: ['onefishCore']`
- [ ] `register` 成功，health 可查
- [ ] `start / stop` 幂等
- [ ] 入站 `requestId` 唯一
- [ ] auto 模式收到 outbound
- [ ] tool 模式没有自动发送
- [ ] 只写 `scope.stateDir`
- [ ] 没有 import core 内部
- [ ] 没有直接调 DSH session
- [ ] 组件禁用/失败不影响 Core
- [ ] `npm test` 通过

## 18. 参考实现

- [echo 组件](../../components/echo)
- [component-sdk](../../packages/component-sdk)
- [ADR-0005](../adr/0005-component-contract.md)
