# ADR-0002: Session runtime 归 DSH，生命周期归 Core

- 状态：Accepted
- 日期：2026-11-13
- 相关：ADR-0001、ADR-0003

## 背景

旧 Core 的 `session` 服务只记录事件计数和最近更新时间，既不是真正的会话存储，也不能支撑“统一会话”。

同时，DSH 已经提供完整会话能力：

- 会话创建、提示词投递、历史读取；
- 上下文窗口、模型调用；
- 会话列表、重命名、归档；
- MCP 工具传输。

如果 Core 再实现一套消息历史，会与 DSH 重复，并产生两个事实来源。

## 决策

### 1. DSH 拥有会话运行时

以下能力全部归 DSH：

- 消息内容、消息历史；
- 上下文窗口和模型调用；
- 会话存储、会话列表、会话 UI；
- MCP 工具传输。

Core 不再保存消息正文作为事实来源，不再实现上下文组装。

### 2. Core 拥有日会话生命周期

Core 只维护一个轻量会话索引和生命周期：

```json
{
  "active": {
    "day": "2026-11-13",
    "sessionId": "session-...",
    "preset": "onefish-core",
    "createdAt": 1760000000000
  },
  "recent": [
    {
      "day": "2026-11-12",
      "sessionId": "session-...",
      "sealedAt": 1760000000000,
      "consolidatedAt": 1760000000000,
      "status": "consolidated"
    }
  ]
}
```

Core 提供以下生命周期操作：

- `ensureToday()`：今天没有会话就创建；
- `current()`：返回当天 active 会话；
- `seal(day)`：封存某天，不再接收新消息；
- `consolidate(day)`：把该天会话内容整理进全量记忆；
- `retire(sessionId)`：从 DSH 界面归档/隐藏旧会话（不是删除历史）。

### 3. 每天一个共享日会话

- 逻辑日边界默认 **04:00（本地时区）**，可配置；
- 每个逻辑日只创建一个 DSH session，preset 为 `onefish-core`；
- 日会话固定放在专用 DSH workspace：标题 `onefish`，路径 `~/.dsh/OneFish`；
- DSH 窗口、QQ、B站、桌宠共用这一天会话；
- 频道组件不自己创建会话，只调用 Core 的 `ensureToday({ channel })` 获取当天 sessionId；
- 跨天第一次访问时，Core 先封存昨天，再创建今天；
- DSH 不在线时跨天，下次启动补做，不要求 04:00 时必须运行。

### 4. “回收”= 归档/隐藏，不是删除

- 旧会话的消息历史和日志保留；
- 通过 DSH 的 archive/retire 能力从日常列表隐藏；
- Core 记录 `archivedAt`，不删除被引用的会话；
- 删除历史数据不属于日会话生命周期。

### 5. 整理属于 Core，消息读取属于 DSH

`consolidate(day)` 的输入来自 DSH 的会话历史 API；输出写入 Core 的全量记忆和 memory-space。

整理流程和记忆分层见 ADR-0003。

## 依赖的 DSH 能力

实现前必须验证并封装到 adapter：

1. `session.create({ agentPreset, cwd?, workspaceId? })` 返回 sessionId；
2. `session.history({ sessionId, beforeSeq?, maxMessages? })` 能分页读取历史；
3. `session.rename({ sessionId, title })` 能命名日会话；
4. `workspace.archiveSession({ sessionId })` 能归档/隐藏旧会话；
5. 能按 `agentPreset` 创建会话。

如果 `session.history` 不可用或历史不完整，退化方案：

- Core 在 `session/event` 上旁路记录当天消息到本地 journal；
- DSH 历史仍是 UI 的事实来源，journal 只用于 consolidation。

如果 archive/retire 不可用：

- 旧会话保留可见；
- Core 只按 `active.day` 区分“当天会话”；
- 通过命名（`OneFish YYYY-MM-DD`）让用户识别。

## 后果

### 正面

- 不重复实现 DSH 会话系统；
- DSH UI 和历史是唯一事实来源；
- Core 体积小，生命周期逻辑集中；
- 频道组件不需要自己管会话；
- 日会话与全量记忆整理天然衔接。

### 负面 / 风险

- 依赖 DSH 的 create/history/archive 接口；
- DSH 升级可能改变历史分页或事件结构；
- 用户可能在旧会话里继续输入，需要 UI/提示策略；
- 多频道并发写同一个日会话，需要队列和顺序保证；
- 整理失败不能阻塞新一天，需要 pending/retry。

## 备选方案

### A. Core 自己保存消息历史（否决）

与 DSH 重复，产生两个事实来源，且会再次引入“统一会话”存储复杂度。

### B. 每个频道一个会话（否决）

破坏统一会话；QQ、B站、桌宠无法共享当天上下文。

### C. 不按天，永久一个会话（否决）

上下文无限增长，记忆整理没有明确边界，不符合日生命周期。

## 验收标准

- 当天首次访问能创建 `onefish-core` preset 的 DSH session；
- 第二天首次访问能创建新 session，旧 session 被封存；
- 旧 session 归档后历史仍可读；
- `consolidate(day)` 幂等：同一天重复执行不重复写；
- 整理失败后保留 pending，下一次启动可重试；
- DSH 关闭期间跨天，下次启动能补做；
- 频道组件只通过公开 API 获取当天 sessionId，不直接创建会话。
