# 用户上下文检索评测基线

本文档记录 Orama 版用户上下文检索的第一阶段评测基线。它不是一次性过程记录，而是后续替换索引、调整 embedding 或修改召回策略时必须回归的长期参考。

## 召回样例

评测只允许检索当前触发用户的数据。以下样例覆盖第一阶段必须稳定的行为：

| 用例 | 用户 | 查询 | 期望 Top 结果 | 不应出现 |
| --- | --- | --- | --- | --- |
| 偏好事实 | user_1 | `我应该怎么称呼你` | `用户希望被称为小王` | user_2 的称呼 |
| 近期项目 | user_1 | `Orama 方案做到哪了` | `用户正在评估 Orama 版上下文检索` | 无关终端命令片段 |
| 工具细节 | user_1 | `终端命令前要注意什么` | `终端命令需要先检查当前目录` | 猫咪偏好 |
| 摘要召回 | user_1 | `之前 SQLite 迁移结论是什么` | `SQLite canonical store 已接入` | 已 deleted 的 chunk |
| 敏感过滤 | user_1 | `秘密 token 是什么` | 无 secret item | `sensitivity=secret` item |
| 跨用户隔离 | user_2 | `Orama 方案做到哪了` | user_2 自己的上下文或空 | user_1 的 Orama 片段 |

通过标准：

- Top 1 命中率应保持在 5/6 以上。
- 跨用户隔离和 `sensitivity=secret` 过滤必须 100% 通过。
- embedding 不可用时，语义召回可以为空，但 `retrievalPolicy=always` 的 user facts 仍应注入。

## 容量曲线

当前轻量索引定位是“每用户热层 Orama 内存索引”。以下数据来自当前开发机、Node 20+、Orama 3.1.18、16 维合成向量、单用户过滤、hybrid search、`limit=16`。

| 每用户文档数 | insertMultiple 耗时 | 平均检索耗时 |
| ---: | ---: | ---: |
| 100 | 3 ms | 0.18 ms |
| 500 | 6 ms | 0.38 ms |
| 1,000 | 13 ms | 0.85 ms |
| 2,000 | 24 ms | 2.58 ms |
| 5,000 | 59 ms | 14.73 ms |
| 10,000 | 83 ms | 53.47 ms |

第一阶段容量建议：

- 默认每用户 active search chunks 控制在 500 条。
- 单用户热层超过 2,000 条时，应优先通过 summary compaction 和 GC 降低 active chunk 数。
- 单用户热层长期超过 5,000 条，或 P95 检索耗时超过 50 ms 时，应评估迁移到 sqlite-vec、LanceDB 或 Qdrant；SQLite canonical store 不需要更换。
- 导入导出不携带 embedding，切换 embedding profile 后通过后台 re-embed/rebuild 重建索引。

## 回归要求

以下变更必须重新跑评测：

- 更换 embedding 模型或文本预处理版本。
- 修改 chunker、summary compaction、GC 策略。
- 调整 Orama hybrid 权重、候选倍率或 minScore。
- 替换检索后端。

评测结果应记录：

- embedding profile ID。
- 每用户 active chunk、summary、fact 数量。
- Top 1 / Top 3 命中率。
- 跨用户隔离和 secret 过滤结果。
- p50 / p95 检索耗时。
