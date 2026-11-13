# OneFish ADR

架构决策记录（Architecture Decision Records）。

| 编号 | 决策 | 状态 |
| --- | --- | --- |
| [0001](0001-core-is-dsh-first.md) | Core is DSH-first：OneFish 作为 DSH 插件内核存在 | Accepted |
| [0002](0002-session-ownership.md) | 会话运行时归 DSH，生命周期归 Core | Accepted |
| [0003](0003-memory-layers-and-consolidation.md) | 全量记忆与 memory-space 分层，日终整理 | Accepted |
| [0004](0004-boot-pack.md) | 日会话创建时注入开机包 | Accepted |

约定：

- ADR 只记录**已经确定**的架构决策，不写实现细节清单；
- 实现细节放各自的设计文档或代码注释；
- 决策改变时新增 ADR，不直接改写旧 ADR 的结论。
