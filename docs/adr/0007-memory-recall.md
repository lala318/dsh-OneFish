# ADR-0007: 每轮记忆召回

- 状态：Accepted
- 日期：2026-11-19
- 相关：ADR-0003、ADR-0004

## 背景

开机包（ADR-0004）只在新一天第一轮把 core 全量 + active 摘要送进上下文。当天聊久了，早期内容会被压缩或滑出窗口；模型也可能像人一样“记得有这事，但想不起细节”。

2026-11-19 晚就漏了一次：主人在备考，旧记忆里写着“2027 年 12 月考试”，我却张口说“离考试一个多月”。记忆库里有答案，模型没去查。

依赖模型每轮主动调 `memory_search` 不可靠：会忘、会懒、会误判“这个我知道”。

## 决策

**每轮收到用户消息后，自动挑几条最相关的旧记忆，以 `developer/message` 注入当前 open step。**

具体：

- 触发：日会话收到 `user/message`；
- 查询：用户这条消息的纯文本（上限 800 字）；短于 `minQueryChars` 或命中跳过前缀（`【空闲】` 等）时不召回；
- 打分：优先用 `memory.search` 的混合结果（本地 bge-small-zh 向量 + 词面），要求 `score >= minScore(0.6)` 且 `relevance >= minRelevance(0.4)`；向量不可用或没命中时退回本地词面兜底（中文二元组），阈值 `lexicalMinScore(0.35)`；
- 范围：只取 core / active，knowledge（梗、黑话）不进；
- 数量：`topK=3`，总长 `maxChars=600`；
- 时长：整次打分限时 `timeoutMs=600`；超时或失败安静跳过，不注水、不卡回复；
- 注入：`session.append('developer/message', { turn, step })`，turn/step 取本进程里最近一次 `step/start`（`user/message` 事件自身不带 turn/step）；
- 频次：同一 turn 只注入一次；首轮（turn 1）跳过——开机包已经覆盖；
- 记录：`session-index.json` 里写 `lastRecallTurn` / `lastRecallAt` / `lastRecallChars` / `lastRecallError`。

## 后果

### 正面

- “信息在库里但没想起来”这类错误有了兜底；
- 不需要额外模型调用，成本只是本地向量检索（预热后 30ms 上下）；
- 失败/超时不影响正常回复；
- 召回内容进会话日志，事后可核对为什么这么答。

### 负面 / 风险

- 中文向量相似度有噪声，可能召回弱相关内容；已用 relevance + score 双阈值收敛，仍需按实际调参；
- 每轮多一段 200 字上下的 developer message，token 成本增加；
- 依赖 user/message 事件与 open step 的时序；若 DSH 变更事件顺序，需要复查注入是否仍落在本轮；
- 召回是提示不是结论：模型仍应自己核对，不能把它当成“已经查证过”。

## 备选方案

### A. 每轮都调 MCP `memory_search`（否决）

取决于模型自觉，且多一次工具往返，慢。

### B. 用完整向量检索并等待结果（部分采用）

向量要加载本地模型，冷启动可到 300ms 以上；这里仍用向量，但限时并保留词面兜底，优先保证不拖慢这一轮。

### C. 只在长会话/压缩后召回（暂不采用）

实现上更难判断“上下文已经滑出”，且效果不如每轮稳定。

## 验收标准

- 第二轮之后的用户消息，若命中记忆，注入一条【记忆召回】`developer/message`；
- 同一轮不重复注入；首轮不注入；
- 短消息、空闲 prompt 不触发；
- 没有 open step、检索超时、注入失败都不影响本轮回复；
- `lastRecallTurn` / `lastRecallError` 可在 `session-index.json` 里核对。
