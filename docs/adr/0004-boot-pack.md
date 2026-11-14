# ADR-0004: 日会话首轮注入开机包

- 状态：Accepted（2026-11-14 修正）
- 日期：2026-11-13
- 相关：ADR-0002、ADR-0003

## 背景

人格/记忆需要在新一天的第一轮对话前就进入模型上下文。依赖模型主动调用 `persona_get` / `memory_search` 不够确定：模型可能不调、晚调，或者只取到一部分。

同时，不能为了注入上下文而伪造一条 user 消息并触发一次模型调用，否则会污染会话、消耗 token。

DSH 的 Session 支持 `developer/message` surface event。它可以进入模型可见上下文，但不会打开 user turn。

## 决策

**日会话创建时准备“开机包”，在首个 open step 注入一次。**

具体：

- 开机包由 Core 生成，不经过模型；
- 注入目标：当天的日会话；
- 注入时机：DSH 首个 `step/start` 后，使用真实 open `turn` / `step`；
- 注入方式：`session.append('developer/message', { turn, step, message: { role: 'developer', content: [{ type: 'text', text }] } }, { surfaceOp: 'append' })`；
- **不产生 user turn，不触发模型调用**；
- 每天只注入一次，状态记录在 `session-index.json` 的 `bootPackAt`；
- 当天已有会话但没有 `bootPackAt` 时允许补注入一次；
- 注入失败只记日志，不阻塞日会话创建；下一次 `ensureToday()` 会重试。

## 开机包内容

按优先级：

1. 核心记忆（core 全量，不截断）；
2. 人格卡（默认上限 2000 字）；
3. 主动记忆（active，默认 500 字）；
4. 昨天的全量档案摘要（若有）；
5. 近期档案日期索引；
6. DSH 场景说明（文本直接显示、记忆工具、分层规则、不要伪造操作）；
7. “今天第一次打开日会话”。

总量默认 `bootMaxChars=5000`，超出时截断非核心部分。

## 2026-11-14 修正：写入 open turn/step

DSH v4 的 `developer/message` 必须匹配一个已经打开的 turn/step。原方案在日会话创建时直接 append，事件落在 `turn/start` 之前；DSH 重启 resume 时会报：

```text
SessionFormatError: developer/message does not match an open turn and step
```

因此改为：

- 创建日会话时只把开机包标记为 `pending`，不写 developer/message；
- 监听 DSH 的 `step/start`，拿到真实的 `turn` / `step` 后再注入；
- 没有 open turn/step 时返回 `skipped`，记录 `bootPackStatus` / `bootPackError`，不写坏事件；
- 成功后写 `bootPackAt` / `bootPackChars` / `bootPackStatus='injected'`；
- 重启后 pending 状态仍可等待第一个 step；已有消息的会话不再补写。

## 后果

### 正面

- 人格/记忆在第一天第一轮就确定可见；
- 不依赖模型主动调用工具；
- 不伪造 user 消息，不触发模型；
- 与“会话运行时归 DSH”一致：上下文仍是 DSH 的 developer message；
- 可预览、可测试、可补注入。

### 负面 / 风险

- 开机包是当天快照，当天修改人格/记忆不会自动刷新；
- 空白会话仍然不会出现在普通会话列表（DSH 的 blank 逻辑不变）；
- 依赖 DSH `session.append` / `developer/message` 接口；
- 大量 core 记忆会让开机包变长，需要控制 core 质量。

## 备选方案

### A. 首次用户消息时拼接开机包（否决）

DSH 原生窗口的 prompt 由 DSH 提交，Core 无法可靠拦截；容易漏注入。

### B. 伪造一条 user 消息（否决）

会触发模型、污染对话，且用户会看到一条不是自己发的消息。

### C. 只靠 MCP 工具按需读取（部分保留）

工具仍然保留，用于当天后续的增量检索；但不能作为首轮上下文的唯一来源。

## 验收标准

- 新建日会话后，`bootPackAt` 非 0（首轮 step/start 注入后）；
- 开机包包含当前人格卡；
- 开机包包含 core 全量记忆；
- 开机包不产生 user turn；
- 同一天不重复注入；
- 注入失败不阻塞会话创建，且可重试；
- 没有 open turn/step 时不会写坏 developer/message；
- 可从设置页/API 预览开机包。
