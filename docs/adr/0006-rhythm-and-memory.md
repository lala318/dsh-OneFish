# ADR-0006: 对话节奏与记忆维护

- 状态：Accepted
- 日期：2026-11-15
- 相关：ADR-0004、ADR-0005

## 背景

旧版插件已有空闲钟、记忆遗忘/向量/夜间整理；Core 拆分后这些能力没有完整迁入。同时，DSH 原生窗口里的用户消息不携带时间，模型容易丢失“现在几点/隔了多久”。

## 决策

### 1. 每轮自动注入时间戳

在活动日会话每轮的第一个 `step/start`，Core 用 `developer/message` 注入一次：

```text
【当前时间】2026-11-15 17:00:00 周六
```

- 不改用户正文；
- 和开机包共用 open turn/step 注入路径；
- `timestamp.enabled=false` 可关闭；
- DSH UI 直聊也覆盖（只要属于 Core 的活动日会话）。

### 2. 空闲钟

- 纯概率/节流逻辑放在 `domain/idle-clock.js`；
- 状态放 `core/idle-clock.json`；
- 默认关闭；开启后按 `minIdleMs`、`scaleHours`、`shape`、随机 cooldown 触发；
- 触发时向当前日会话发一条“这是你自己的时间”的主动 prompt；
- 有 `idle_status` / `idle_preview` MCP 和 `/idle/status|preview|run` HTTP 接口。

### 3. 记忆遗忘曲线

- stability 由 importance、useCount、tier 决定；
- retention = `exp(-ageDays / stabilityDays)`；
- activeBlock 使用 memoryScore，不再用固定 90 天衰减；
- 夜间维护把 retention/stability/dormant 写入 `meta`，不删除原文；
- dormant 记忆不自动进主动注入，但仍可搜索/恢复。

### 4. 向量索引

- 索引路径：`memory-v2/space/vectors/index.jsonl`；
- 当前使用本地 char n-gram hash 向量（256 维），零网络依赖；
- `textHash` 增量复用；
- `memory_search` 做 lexical + cosine 混合排序；
- embedding 实现可替换，索引格式不变。

### 5. 夜间整理

日终 consolidation 成功后执行 `memory.maintain`：

1. `applyDecay`：更新 retention/stability/dormant；
2. `dedupe`：正文相同的条目保留最强一条，其余软删；
3. `buildVectorIndex`：重建向量索引；
4. 写 `lastMaintainedDay` 和 audit。

手动入口：`memory_maintain` MCP / `POST /api/memory/maintain`。

## 后果

- 时间在每轮都可见，不再依赖消息正文携带；
- 空闲钟是可配置的，不默认打扰；
- 记忆衰减可解释、可恢复，不直接丢原文；
- 向量索引本地可用，但不是 bge/ONNX 语义向量；后续可替换 embedding 适配器。

## 验收

- 每轮 step/start 后出现一次时间 developer/message；
- `memory_search` 可返回 vector/hybrid 结果；
- `memory_maintain` 产生 vector index / retention；
- 空闲钟默认 disabled，开启后 status/check 可用。
