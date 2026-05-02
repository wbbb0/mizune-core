# 用户上下文混合检索完整实现计划

## 目标

把当前依赖模型主动写入 `user_memories` 的长期上下文机制，逐步收敛为“自动沉淀、自动检索、统一注入”的用户上下文系统。

第一阶段只覆盖“当前触发用户相关的历史会话”，不做全局跨用户、跨群、跨所有会话的自动联想。

核心目标：

- 自动从当前用户的历史聊天中召回相关上下文。
- 降低 prompt 中固定注入长期记忆的 token 消耗。
- 降低对模型主动调用记忆写入工具的依赖。
- 保持用户边界清晰，默认不越权召回其他用户上下文。
- 收敛旧 `user_memories` 到统一上下文存储，避免新旧两套长期记忆系统并存。
- 保留可迁移边界，后续可从 Orama 切换到 LanceDB、SQLite + sqlite-vec 或 Qdrant。
- 控制长期运行后的历史容量，避免热检索层无限膨胀。

## 总体结论

第一版建议采用：

- 项目自己的 canonical store 保存原始消息、chunk、summary、fact。
- `@orama/orama` 只作为可重建的本地候选召回索引。
- embedding 作为项目模型系统中的一种模型类型处理，类似听写模型；每个 provider 可以有自己的接口适配，不绑定 Orama embedding plugin。
- 向量索引按 `embeddingProfileId` 隔离，不混用不同 embedding 模型生成的向量。
- 历史容量通过分层、摘要化、归档和自动 GC 控制。
- `scope` 表示数据生效范围，`sourceType` 表示数据形态，`retrievalPolicy` 表示注入策略。三者作为统一查询条件，不拆成多套存储系统。
- `user_memories` 最终迁移为 `scope=user + sourceType=fact` 的 `context_items`，旧字段和旧 prompt 段不长期保留。

Orama 不是唯一数据源。Orama 索引可以删除、重建、切换 profile。真正的历史数据以项目存储为准。

该功能不作为独立可选系统长期保留，而是内建为新的记忆与上下文底座。它工作不正常时必须 fail-open：禁用出问题的检索、embedding、摘要或维护子能力，但不能阻断普通聊天、OneBot、WebUI、工具调用和核心 facts/rules 直接注入。

## 非目标

- 不引入 LangChain、LlamaIndex 等完整 RAG 框架。
- 不在第一阶段部署 Qdrant 服务或 Milvus。
- 不把 `persona`、`global_rules`、`toolset_rules`、`user_profile` 全部检索化。
- 不让 LLM 临场决定所有入库、清理、注入策略。
- 不把 raw message 直接长期作为 prompt 注入内容。

## 术语

- `raw_message`：原始聊天消息，是可追溯事实源。
- `context_chunk`：从近期聊天中切出的细粒度检索单元。
- `session_summary`：对较旧聊天或多个 chunk 的压缩摘要。
- `memory_fact`：长期稳定、跨会话有用、低歧义的事实卡片。
- `canonical store`：项目自己的权威数据存储。
- `retrieval index`：可重建检索索引，第一版使用 Orama。
- `embedding profile`：embedding 模型、维度、文本预处理和 chunk 版本的组合。
- `scope`：数据属于谁、在哪个范围生效，例如 `session`、`user`、`global`、`toolset`、`mode`。
- `sourceType`：数据形态和生命周期，例如 `chunk`、`summary`、`fact`、`rule`。
- `retrievalPolicy`：注入策略，例如 `always`、`search`、`never`。

## 统一数据模型

`scope` 和 `sourceType` 是两个正交维度：

- `scope` 控制存储范围、权限边界和生效范围。
- `sourceType` 控制数据是什么、如何生成、如何清理。
- 查询时通过两者组合得到不同范围的数据。

示例：

```ts
type ContextScope = "session" | "user" | "global" | "toolset" | "mode";
type ContextSourceType = "chunk" | "summary" | "fact" | "rule";
type RetrievalPolicy = "always" | "search" | "never";

interface ContextItem {
  itemId: string;
  scope: ContextScope;
  sourceType: ContextSourceType;
  retrievalPolicy: RetrievalPolicy;
  status: "active" | "archived" | "deleted";

  userId?: string;
  sessionId?: string;
  toolsetId?: string;
  modeId?: string;

  title?: string;
  text: string;
  kind?: string;
  source?: "user_explicit" | "owner_explicit" | "inferred" | "system";
  confidence?: number;
  importance?: number;
  pinned?: boolean;
  sensitivity?: "normal" | "private" | "secret";

  createdAt: number;
  updatedAt: number;
  validFrom?: number;
  validTo?: number;
  supersededBy?: string;
  lastConfirmedAt?: number;
  retrievedCount?: number;
  lastRetrievedAt?: number;

  sourceRefs?: ContextSourceRef[];
  coveredItemIds?: string[];
  coveredMessageIds?: string[];
  embeddingProfileId?: string;
  embedding?: number[];
}
```

典型组合：

- `scope=session + sourceType=chunk`
  - 当前会话近期片段。
- `scope=user + sourceType=fact`
  - 某用户长期事实，覆盖旧 `user_memories`。
- `scope=user + sourceType=summary`
  - 某用户旧会话摘要。
- `scope=global + sourceType=rule`
  - owner 级全局行为规则。
- `scope=toolset + sourceType=rule`
  - 只在某个工具集启用时生效的规则。
- `scope=mode + sourceType=fact|summary|rule`
  - 只在某个模式下生效的模式资料或模式历史。

查询示例：

```ts
// 当前用户长期事实
{ scope: "user", userId: currentUserId, sourceType: "fact", status: "active" }

// 当前会话热历史
{ scope: "session", sessionId, sourceType: "chunk", status: "active" }

// 当前工具集规则
{ scope: "toolset", toolsetId: activeToolsetId, sourceType: "rule", retrievalPolicy: "always" }

// 需要语义检索的候选
{
  scope: ["session", "user"],
  sourceType: ["chunk", "summary", "fact"],
  retrievalPolicy: "search",
  status: "active",
  embeddingProfileId: activeProfileId
}
```

## 架构分层

### 1. 原始层 `raw_messages`

保存所有原始消息：

- `messageId`
- `userId`
- `sessionId`
- `chatType`
- `role`
- `speakerId`
- `timestampMs`
- `text`
- `segments`
- `attachmentRefs`
- `ingestedAt`
- `sensitivity`

用途：

- 审计和回溯。
- 重建 chunk。
- 重新摘要。
- 切换 embedding 后重建索引。

约束：

- 不直接进入 prompt。
- 可以按月份 JSONL 或 SQLite 表分区保存。
- 敏感内容、密钥、一次性 token 应在进入检索层前过滤或脱敏。

### 2. 热检索层 `context_chunks`

保存近期、细节重要、适合语义召回的上下文：

- `itemId`
- `scope: "session" | "user"`
- `sourceType: "chunk"`
- `retrievalPolicy: "search"`
- `userId`
- `sessionId`
- `text`
- `timeRange`
- `sourceMessageIds`
- `tokenEstimate`
- `importance`
- `retrievedCount`
- `lastRetrievedAt`
- `status`
- `pinned`
- `sensitivity`
- `embeddingProfileId`
- `embedding`

适合进入 chunk 的信息：

- 当前任务细节。
- 路径、命令、错误、配置片段。
- 近期偏好或一次性约束。
- 还不能判断是否长期稳定的信息。

生命周期：

- 新消息进入 raw 后，异步生成 chunk。
- chunk 进入 Orama 热索引。
- 超过保留天数或用户配额后，被 summary 覆盖并归档。

### 3. 温存层 `session_summaries`

保存旧会话或旧 chunk 的压缩视图：

- `itemId`
- `scope: "session" | "user" | "mode"`
- `sourceType: "summary"`
- `retrievalPolicy: "search"`
- `userId`
- `sessionId`
- `modeId`
- `summaryScope`
- `text`
- `coveredItemIds`
- `coveredMessageIds`
- `timeRange`
- `importance`
- `retrievedCount`
- `lastRetrievedAt`
- `status`
- `pinned`
- `sensitivity`
- `embeddingProfileId`
- `embedding`

适合进入 summary 的信息：

- 会话阶段性结论。
- 旧任务整体进展。
- 多个 chunk 合并后的低 token 表达。
- 不需要保留原始细节但仍可能被未来召回的信息。

生命周期：

- 后台 compaction job 从旧 chunk 生成 summary。
- summary 继续参与检索。
- 多个旧 summary 可继续合并成更高层 summary。

### 4. 稳定事实层 `memory_facts`

保存长期稳定、跨会话有用、低歧义的事实：

- `itemId`
- `scope: "user" | "mode"`
- `sourceType: "fact"`
- `retrievalPolicy: "always" | "search"`
- `userId`
- `modeId`
- `title`
- `text`
- `kind`
- `confidence`
- `sourceRefs`
- `lastConfirmedAt`
- `importance`
- `retrievedCount`
- `lastRetrievedAt`
- `status`
- `pinned`
- `validFrom`
- `validTo`
- `supersededBy`
- `sensitivity`
- `embeddingProfileId`
- `embedding`

适合进入 fact 的信息：

- 用户明确长期偏好。
- 用户长期工作方式。
- 项目长期规则。
- 反复确认且无冲突的稳定事实。
- 用户手动 pin 或明确要求“记住”的内容。

不适合进入 fact 的信息：

- 一次性请求。
- 临时任务状态。
- 未确认推测。
- 已过期端口、临时路径、短期调试状态。
- 密钥、token、密码等敏感信息。

### 5. 规则层 `rules`

保存行为规则，而不是用户事实：

- `itemId`
- `scope: "global" | "toolset" | "mode"`
- `sourceType: "rule"`
- `retrievalPolicy: "always"`
- `toolsetId`
- `modeId`
- `title`
- `text`
- `importance`
- `status`
- `pinned`
- `validFrom`
- `validTo`
- `supersededBy`

规则层可以逐步吸收现有 `global_rules` 和 `toolset_rules` 的存储形态，但第一阶段不强制把它们改成向量检索。规则默认直接注入，不依赖 embedding。

适合进入 rule 的信息：

- owner 级跨任务默认做法。
- 某个工具集或工作流专属规则。
- 某个模式下必须长期遵守的规则。

不适合进入 rule 的信息：

- 单个用户的偏好。
- 当前会话的一次性要求。
- 需要按语义召回的历史细节。

## 信息分层判断规则

所有消息先进入 `raw_messages`。其他层是从 raw 派生的视图。

默认判定：

- 近期细节重要：进入 `context_chunks`。
- 旧历史仍有主题价值：进入 `session_summaries`。
- 长期稳定、低歧义、跨会话有用：进入 `memory_facts`。
- 不确定是否长期稳定：先留在 chunk 或 summary，不提升为 fact。

自动提升 fact 的触发线索：

- 用户明确说“以后”“默认”“记住”“我喜欢”“我不喜欢”“不要再”“始终”“每次”。
- 同一事实在多次会话中重复出现且无冲突。
- 事实有明确 sourceRefs，且不包含敏感信息。
- 用户在 WebUI 或聊天命令中手动 pin。

LLM 可以用于抽取候选 fact，但最终入库必须经过规则门控。

## 旧记忆功能收敛方案

不建议把旧 `user_memories` 与新上下文检索长期做成两个系统。推荐路线是“新存储全量接管，语义检索子能力可降级”：

- `users.json` 中的 `memories` 迁移为 `context_items`：
  - `scope=user`
  - `sourceType=fact`
  - `retrievalPolicy=always` 或 `search`
  - `title -> title`
  - `content -> text`
  - `kind -> kind`
  - `source -> source`
  - `importance -> importance`
  - `lastUsedAt -> lastRetrievedAt`
  - `createdAt/updatedAt` 原样保留
- `list_user_memories` 替换为查询用户 facts。
- `upsert_user_memory` 替换为 upsert 用户 fact。
- `remove_user_memory` 替换为把对应 fact 标记为 `deleted`。
- `current_user_memories` prompt 段替换为 `current_user_facts` 或统一的 `retrieved_context`。
- 旧 `UserStore.upsertMemory/removeMemory/overwriteMemories` 在迁移完成后删除。

兼容策略：

- 可以在一个短迁移窗口内保留旧工具名作为薄包装，但不保留旧数据路径。
- 旧工具名只调用新的 `ContextStore`，不再写 `users[].memories`。
- 项目当前约定默认不保留兼容层，因此迁移完成后应删除旧工具名、旧字段和旧测试。

检索子能力不可用或被维护开关暂停时的行为：

- 不生成 embedding。
- 不构建 Orama 索引。
- 不注入 `retrieved_context`。
- 仍然直接注入 `retrievalPolicy=always` 的 facts/rules/profile/persona。
- 这相当于旧长期记忆直接注入能力的替代，不会导致核心聊天能力不可用。

## 存储设计

正式实现默认使用 SQLite 作为 canonical store。JSONL 不作为主存储，只保留为 POC、导入、导出或调试格式。

推荐目录：

```text
data/<instance>/context/context.sqlite
data/<instance>/context/orama/<embeddingProfileId>.snapshot.json
data/<instance>/context/exports/*.jsonl
```

多实例隔离要求：

- 每个 `CONFIG_INSTANCE` 必须使用自己的 `data/<instance>/context/` 目录。
- SQLite 数据库、Orama snapshot、导入导出文件都必须落在实例目录下。
- 不允许多个 instance 共享同一个 Orama snapshot 或 embedding profile 文件。
- 不允许用全局默认路径保存 context 数据。
- 维护任务、GC、reindex 只能处理当前 instance 的数据目录。
- 内部 API 和 WebUI 查询 context 数据时必须绑定当前 instance，不提供跨 instance 混查入口。
- 不同 instance 可以使用不同 embedding 模型、不同维度和不同 chunker 版本；索引与向量完全独立。

SQLite 表建议：

- `raw_messages`
- `context_items`
- `context_item_sources`
- `context_item_embeddings`
- `embedding_profiles`
- `maintenance_jobs`
- `manual_audit_events`

`context_item_embeddings` 存储要求：

- 以 `itemId + embeddingProfileId` 作为唯一键。
- 向量用 BLOB 保存 `Float32Array`，不要用 JSON 数组长期保存。
- 保存 `dimension`、`createdAt`、`updatedAt`。
- 支持按 profile 删除旧向量。

建议索引：

- `raw_messages(instanceName, userId, sessionId, timestampMs)`
- `context_items(scope, userId, sourceType, status, retrievalPolicy)`
- `context_items(scope, sessionId, sourceType, status)`
- `context_items(scope, toolsetId, sourceType, status)`
- `context_items(scope, modeId, sourceType, status)`
- `context_item_embeddings(embeddingProfileId, itemId)`
- `maintenance_jobs(status, scheduledAt)`

JSONL 导入导出格式：

```text
data/<instance>/context/exports/context-items-<timestamp>.jsonl
data/<instance>/context/exports/raw-messages-<timestamp>.jsonl
```

导入时必须进入 SQLite，再由 reindex job 重建 Orama，不直接写 Orama snapshot。

Orama 无论哪种 canonical store 都只作为索引，不作为权威存储。

## Embedding Profile

同一检索索引内必须使用同一个 `embeddingProfileId`。

Embedding provider 应纳入项目现有模型配置体系，作为独立模型类型，而不是 context 模块私有配置。建议新增或扩展模型类型：

- `chat`
- `vision`
- `audio_transcription`
- `embedding`

context 模块只依赖一个抽象接口：

```ts
interface EmbeddingModelAdapter {
  embedTexts(input: {
    model: string;
    texts: string[];
    timeoutMs?: number;
  }): Promise<{
    vectors: number[][];
    dimension: number;
    providerMetadata?: Record<string, unknown>;
  }>;
}
```

每个 provider 可以有自己的 adapter：

- OpenAI-compatible `/v1/embeddings`。
- LM Studio OpenAI-compatible embedding。
- 阿里云百炼 embedding。
- 未来其他本地或云 embedding provider。

这样 embedding 与听写模型一样由模型系统统一解析 provider、model、baseURL、credential、timeout 和健康检查。context 模块不直接理解每个 provider 的接口差异。

每个 instance 独立选择自己的 embedding profile：

- instance A 可以使用本地 Qwen embedding。
- instance B 可以使用云 embedding。
- 两者数据目录、profile、向量维度、Orama snapshot 完全分离。
- 切换某个 instance 的 embedding 不影响其他 instance。

`embeddingProfileId` 由以下信息决定：

- `instanceName`
- `provider`
- `model`
- `dimension`
- `distance`
- `textPreprocessVersion`
- `chunkerVersion`

示例：

```json
{
  "id": "dev-lmstudio-qwen3-embedding-0.6b-v1",
  "instanceName": "dev",
  "provider": "openai-compatible",
  "model": "text-embedding-qwen3-embedding-0.6b",
  "dimension": 1024,
  "distance": "cosine",
  "textPreprocessVersion": "mixed-zh-bigram-v1",
  "chunkerVersion": "chat-window-v1",
  "active": true,
  "createdAt": 1770000000000
}
```

切换 embedding 的流程：

1. 新建 embedding profile。
2. 后台基于 canonical text 重新生成 embedding。
3. 构建 shadow Orama index。
4. 用固定评测样例和 debug report 对比召回质量。
5. 切换 active profile。
6. 保留旧 profile 一段回滚窗口。
7. GC 删除旧 profile 的索引和向量。

只要 raw、summary、fact 文本仍在，历史数据不会失效；失效的是旧向量索引。

## 运行依赖与降级行为

### 必需依赖

基础记忆能力依赖项目已有能力：

- Node.js 运行时。
- 每个 instance 独立的 SQLite canonical store。
- 当前聊天模型能力。

语义检索子能力额外需要：

- 一个配置为 `embedding` 类型的模型。
  - 由模型系统解析 provider 和 adapter。
  - 可以是本地 LM Studio，也可以是云服务。
  - 每个 instance 可以配置不同 embedding 模型。
- `@orama/orama`。
  - 第一版作为本地可重建 hybrid search 索引。
  - 当前 POC 里 `@orama/orama@3.1.18` 没有传递依赖。

### 可选依赖

这些能力不是第一版必需：

- LLM 摘要/事实抽取子能力。
  - 用于 summary compaction 和 fact candidate extraction。
  - 可以复用当前聊天模型，不需要新增模型依赖。
- WebUI 管理界面。
  - 不是检索运行必需，但长期维护建议提供。
- LanceDB / Qdrant。
  - 都不是第一版必需。只有当 Orama 检索索引容量不够时再考虑。

### 依赖不满足时的影响

embedding 模型不可用：

- 不能为新 chunk/summary/fact 生成向量。
- 不能执行向量或 hybrid 检索。
- 系统应自动降级为：
  - 直接注入 `retrievalPolicy=always` 的 facts/rules/profile/persona。
  - 关键词检索或最近摘要 fallback。
  - 跳过本轮 `retrieved_context`，记录日志，不中断回复。
- 不应影响 OneBot 接入、WebUI、普通聊天、工具调用、已有 persona/profile/rules 注入。
- 不应影响其他 instance；故障只影响当前 instance 的 context 语义检索。

Orama 依赖缺失、索引文件损坏或加载失败：

- 不能执行 Orama hybrid search。
- 系统应从 canonical store 重建索引。
- 重建失败时降级为直接注入核心 facts/rules 和当前会话摘要。
- 不应阻塞应用启动；只应将 `contextRetrieval.searchAvailable=false` 暴露给日志和诊断接口。
- 不应读取或重建其他 instance 的索引。

LLM 摘要能力不可用：

- raw 和 chunk 仍可保存。
- 不能自动把旧 chunk 压成 summary。
- GC 应暂停“摘要后归档”步骤，只做索引清理和显式删除。
- 若容量达到硬上限，应停止继续索引低优先级 chunk，而不是删除未摘要历史。

canonical store 不可写：

- 这是严重故障。
- 不能保存新上下文或手动记忆变更。
- 系统应禁用 ingest/GC/reindex 写操作，并记录错误。
- 已加载的内存索引可以继续只读服务，但不能承诺长期保存。
- 普通聊天仍可继续，但长期记忆更新不可用。

当前 instance 未配置可用 embedding 模型：

- 启动时记录 `context_embedding_model_unavailable`。
- 不启动向量写入和 Orama hybrid 检索。
- 仍启动 `ContextStore`、直接注入核心 facts/rules，并允许手动管理。

## 检索流程

### 查询构建

每轮生成前构建 retrieval query：

- 当前触发用户 `userId`
- 当前 batch 文本
- 当前会话最近若干条消息摘要
- 当前模式 `mode`
- 当前 chatType
- 当前 `sessionId`
- 当前激活工具集 `activeToolsetIds`
- 可选任务标签

### 候选召回

Orama 查询参数：

- `mode: "hybrid"`
- `term: queryText`
- `vector.value: queryEmbedding`
- `vector.property: "embedding"`
- `where.user_id: userId`
- `where.scope` 限制在当前允许范围。
- `where.status: "active"`
- `where.retrieval_policy: "search"`
- `limit: topK * candidateMultiplier`
- `includeVectors: false`

项目侧二次排序：

- Orama hybrid score。
- sourceType 加权：fact、summary、chunk 可分别调权。
- recency 加权。
- importance 加权。
- pinned 加权。
- retrievedCount 降噪。
- 近重复抑制。
- token budget 裁剪。

允许范围由当前会话构建：

```ts
const allowedScopes = [
  { scope: "session", sessionId },
  { scope: "user", userId: currentUserId },
  { scope: "mode", modeId: currentMode, userId: currentUserId },
  ...activeToolsetIds.map((toolsetId) => ({ scope: "toolset", toolsetId })),
  { scope: "global" }
];
```

第一阶段的语义检索建议更保守：

- `search` 只查 `scope=session` 和 `scope=user`。
- `global/toolset/mode` 规则仍按 `always` 直接注入。
- 不做跨用户自动召回。

### Prompt 注入

新增统一 prompt section：

```text
⟦section name="retrieved_context"⟧
- [fact] 2026-04-30 | 用户偏好先给结论，再展开理由。
- [summary] 2026-04-30 | 之前评估过 Orama 作为轻量本地检索索引，保留可迁移边界。
- [chunk] 2026-04-30 | 本次 POC 位于 poc/user-context-hybrid-retrieval-orama。
⟦/section⟧
```

注入规则：

- 保留 `persona`、`global_rules`、`toolset_rules`、`user_profile` 的直接结构化注入。
- `retrieved_context` 替代当前 `user_memories` 的主职责。
- `user_memories` 可在迁移期映射为 `memory_facts`。
- `retrievalPolicy=always` 的 facts/rules 不依赖 embedding，可在语义检索暂停或失败时继续直接注入。
- `retrievalPolicy=search` 的 chunk/summary/fact 才进入 Orama 候选召回。
- `retrievalPolicy=never` 的数据只保留在 canonical store，用于审计、导出或重建，不进入 prompt。

## 自动垃圾清理

自动 GC 必须实现，但第一版应保守：优先摘要化和归档，少做硬删除。

### 状态

`context_items.status`：

- `active`：可被索引和检索。
- `archived`：保留在 canonical store，但不进热索引。
- `deleted`：用户或系统标记删除，等待宽限期后物理清除。
- `superseded`：被更新事实替代，不进入 prompt，但保留追溯关系。

### 默认策略

```ts
const policy = {
  hotChunkMaxAgeDays: 30,
  hotChunkMaxPerUser: 1000,
  summaryMaxPerUser: 300,
  factMaxPerUser: 200,
  deletedRetentionDays: 14,
  staleEmbeddingProfileRetentionDays: 30,
  candidateMultiplier: 4,
  secretRetentionPolicy: "never_index",
  inferredFactDefaultConfidence: 0.4,
  factInjectionMinConfidence: 0.65
};
```

### GC 阶段

1. 选择候选 chunk：
   - 旧于 `hotChunkMaxAgeDays`。
   - 用户 chunk 数超过 `hotChunkMaxPerUser`。
   - 未 pinned。
   - 低 importance。
   - 长期未 retrieved。

2. 生成或更新 summary：
   - 按用户、会话、时间窗口聚合。
   - LLM 只做摘要生成。
   - 生成 summary 后记录 `coveredItemIds`。

3. 归档 chunk：
   - 已被 summary 覆盖的 chunk 标记 `archived`。
   - 从 Orama active index 移除或下次重建时跳过。

4. 合并旧 summary：
   - 同一会话多条旧 summary 可合并。
   - 旧 summary 标记 `archived`。

5. 处理 fact：
   - pinned fact 不自动删除。
   - 低 confidence、长期未命中、重复 fact 标为 review candidate。
   - 冲突 fact 进入人工复核，不自动覆盖。
   - 新事实明确替代旧事实时，把旧事实标记为 `superseded`，并设置 `supersededBy`。
   - 有 `validTo` 且已过期的 fact 不再注入，但仍保留用于追溯。

6. 清理索引：
   - 删除无 active profile 的 Orama snapshot。
   - 删除 old embedding profile 的 embedding 字段。
   - 重建 active Orama index。

7. 硬删除：
   - 仅对 `deleted` 且超过宽限期的数据物理删除。
   - 用户明确要求“彻底忘记”时可跳过宽限期，但需要记录 audit event。

### GC 评分

可用一个可解释评分选择优先归档对象：

```ts
gcScore =
  ageScore * 0.35 +
  sizeScore * 0.20 +
  duplicateScore * 0.20 +
  lowUsageScore * 0.20 -
  importance * 0.30 -
  pinnedBonus;
```

分数只用于排序，不能覆盖硬规则。`pinned`、敏感删除请求、用户边界始终优先于分数。

### 敏感信息策略

`sensitivity` 控制保存和索引方式：

- `normal`
  - 可按普通规则进入 chunk/summary/fact。
- `private`
  - 可保存到 canonical store，但默认不进入跨会话检索，除非用户明确允许或手动 pin。
- `secret`
  - 不生成 embedding，不进入 Orama，不进入 summary。
  - 默认只保留 raw 中的脱敏引用，或直接拒绝保存。

识别为 secret 的内容包括：

- API key、token、密码。
- 私钥、cookie、session。
- 一次性验证码。
- 明确标注不要保存的内容。

### 有效期和替代关系

长期事实不是只能覆盖或删除。建议保留事实历史：

- `validFrom`
  - 事实开始生效时间。
- `validTo`
  - 事实结束生效时间。
- `supersededBy`
  - 被哪条新事实替代。

例子：

- 旧事实：“用户偏好用 pnpm。”
- 新事实：“用户现在改回 npm。”
- 处理方式：
  - 旧事实设置 `validTo=now`、`supersededBy=<newItemId>`、`status=superseded`。
  - 新事实 `status=active`。

注入和检索默认只使用 `active` 且未过期的 item。

## 手动管理能力

WebUI 和内部 API 应支持：

- 按 scope、用户、会话、工具集、模式、时间、sourceType、status、retrievalPolicy 筛选。
- 查看 raw、chunk、summary、fact 的来源关系。
- 搜索历史项。
- 删除某条、某会话、某用户全部上下文。
- pin / unpin。
- 编辑 summary / fact。
- 标记 fact 错误、过期、已确认。
- 查看和处理 superseded / expired / review candidate。
- 修改 `retrievalPolicy`。
- 修改 `sensitivity`。
- 手动触发 compact。
- 手动触发 re-embed / rebuild index。
- 查看每用户占用统计。
- 查看依赖状态：embedding 是否可用、Orama 索引是否可用、最近 reindex/GC 是否成功。
- 导出 / 导入 JSONL。

聊天命令可支持：

- 忘记这段。
- 忘记这个会话。
- 忘记关于某个话题的信息。
- 以后记住这条。
- 不要把这个会话用于长期记忆。

## 服务边界

新增模块建议：

```text
src/context/
  contextTypes.ts
  contextConfig.ts
  contextStore.ts
  rawMessageStore.ts
  contextChunker.ts
  embeddingProfiles.ts
  embeddingProvider.ts
  retrieval/
    contextRetriever.ts
    oramaContextIndex.ts
    scoring.ts
  maintenance/
    contextMaintenanceService.ts
    contextCompactor.ts
    contextGarbageCollector.ts
    contextReindexer.ts
  prompt/
    retrievedContextPrompt.ts
```

关键接口：

```ts
interface ContextRetriever {
  retrieve(input: ContextRetrievalInput): Promise<RetrievedContextReport>;
}

interface ContextStore {
  appendRawMessages(messages: RawContextMessage[]): Promise<void>;
  upsertItems(items: ContextItem[]): Promise<void>;
  listActiveItems(input: ListContextItemsInput): Promise<ContextItem[]>;
  markItemsArchived(itemIds: string[], reason: string): Promise<void>;
  markItemsDeleted(itemIds: string[], reason: string): Promise<void>;
  markItemsSuperseded(input: MarkSupersededInput): Promise<void>;
}

interface ContextMaintenanceService {
  ingestTurn(input: IngestTurnInput): Promise<void>;
  compactUser(userId: string): Promise<CompactionReport>;
  garbageCollect(input: GarbageCollectInput): Promise<GarbageCollectReport>;
  rebuildIndex(profileId: string): Promise<RebuildIndexReport>;
  checkDependencies(): Promise<ContextDependencyStatus>;
}
```

## 配置

建议新增配置段：

```yaml
contextRetrieval:
  backend: orama
  embeddingModel: context_embedding
  embeddingProfile: dev-lmstudio-qwen3-embedding-0.6b-v1
  topK: 5
  candidateMultiplier: 4
  maxPromptTokens: 1200
  ingest:
    enabled: true
    minTextChars: 12
    chunkMaxChars: 1200
    chunkOverlapChars: 120
  gc:
    enabled: true
    schedule: "daily"
    hotChunkMaxAgeDays: 30
    hotChunkMaxPerUser: 1000
    summaryMaxPerUser: 300
    factMaxPerUser: 200
    deletedRetentionDays: 14
  fallback:
    onEmbeddingUnavailable: lexical
    onIndexUnavailable: direct_core_context
    failOpenForChat: true
  sensitivity:
    indexPrivateByDefault: false
    indexSecret: false
```

`contextRetrieval` 不再用总开关表达“是否启用新记忆系统”。新系统是默认记忆底座。配置里的子项只控制检索、ingest、GC、fallback 等子能力如何工作。

模型配置中应增加 embedding 模型引用，示例：

```yaml
models:
  context_embedding:
    type: embedding
    provider: lmstudio
    model: text-embedding-qwen3-embedding-0.6b
    baseUrl: http://localhost:1234/v1
    timeoutMs: 120000
```

每个 instance 可以覆盖 `contextRetrieval.embeddingModel`，并生成自己的 `embeddingProfile`。不同 instance 的 profile ID 不应复用。

## 观测与调试

日志事件：

- `context_dependency_status_changed`
- `context_embedding_model_unavailable`
- `context_instance_storage_isolated`
- `context_raw_messages_ingested`
- `context_chunks_indexed`
- `context_retrieval_completed`
- `context_retrieval_fallback_used`
- `context_retrieval_item_selected`
- `context_retrieval_item_dropped`
- `context_compaction_completed`
- `context_gc_completed`
- `context_embedding_profile_switched`
- `context_index_rebuilt`
- `context_manual_item_updated`

调试报告应包含：

- query text。
- active embedding profile。
- dependency status。
- fallback mode。
- 候选列表。
- 每条候选的 Orama score、source bonus、recency、importance、final score。
- selected / dropped。
- drop reason。
- token budget 裁剪结果。

## 测试计划

单元测试：

- chunker 切分稳定性。
- tokenizer 中英文混合行为。
- embedding profile 维度检查。
- Orama index 用户过滤。
- hybrid candidate 召回。
- sourceType、recency、importance 排序。
- scope 过滤和跨 scope 查询组合。
- retrievalPolicy always/search/never 行为。
- sensitivity normal/private/secret 行为。
- validTo 和 supersededBy 过滤。
- 近重复抑制。
- prompt token budget 裁剪。
- GC 不处理 pinned item。
- GC 先 summary 覆盖再 archive chunk。
- GC 不索引 secret。
- GC 不硬删 active/superseded 追溯链。
- deleted 宽限期后硬删除。
- embedding 不可用时 fallback 不阻断普通聊天。
- Orama 索引损坏时可从 canonical store 重建。

集成测试：

- 一轮消息 ingest 后能被检索。
- 旧 chunk compact 后 summary 能被检索，chunk 不再进入 active index。
- embedding profile 切换后 shadow index 可用。
- 手动删除后 index 重建不再出现该项。
- 旧 `users[].memories` 迁移为 `scope=user + sourceType=fact`。
- 旧工具名迁移期只写新 store，不再写旧字段。

回归测试：

- 新记忆底座启用后，普通聊天 prompt 行为除记忆段来源变化外保持等价。
- `persona`、`global_rules`、`toolset_rules`、`user_profile` 注入优先级不被检索层破坏。
- 用户 A 不能召回用户 B 的上下文。
- 语义检索子能力暂停或故障时仍能直接注入 `retrievalPolicy=always` 的核心 facts/rules。
- embedding 模型不可用时不影响 OneBot、WebUI、普通聊天和非检索工具。
- instance A 的 embedding profile、Orama snapshot、raw/items 文件不会被 instance B 读取、写入、GC 或 reindex。

## 实施阶段

## 当前实现进度

截至当前 POC worktree：

- 阶段 0 已完成。
- 阶段 1 已完成最小可用闭环：
  - SQLite canonical store 已接入，路径位于当前 instance 的 `data/<instance>/context/context.sqlite`。
  - 旧 `users[].memories` 启动后迁移为 `context_items` user facts，迁移成功后清空旧字段，WebUI 用户编辑器不再暴露旧 memories。
  - 旧记忆工具名仍作为薄包装保留，但只读写 `ContextStore`。
  - 当前触发消息写入 `raw_messages`。
  - 当前 prompt 历史和本轮消息沉淀为 `scope=user + sourceType=chunk + retrievalPolicy=search`。
  - embedding 作为 `modelType=embedding` 接入模型路由。
  - Orama 作为内存索引 adapter 接入，按 user 和 embedding profile 隔离。
  - prompt 注入固定 user facts 和语义召回的 `retrieved_user_context`。
  - context 写入、检索、embedding 故障已按 fail-open 处理，不阻断普通 prompt 构建。
  - 同步补 embedding 已设上限，避免主聊天路径一次性处理全部历史。
- 阶段 2 已完成基础项：
  - 自动 GC 已能按每用户 chunk 数量和年龄清理 active search chunks。
  - 内部 API 已能查看 context store 与 embedding 依赖状态。
  - 手动删除改为 `status=deleted`，不直接破坏审计状态。
  - 已提供手动 summary compaction，可将旧 chunk 摘要化并归档源 chunk。
  - 已提供 deleted retention 硬清理接口。
  - 已提供后台维护服务，启动后按 `context.retention.maintenanceIntervalMs` 自动执行摘要化、chunk GC 和 deleted retention 清理。
  - 已提供 clear embeddings 和 reset in-memory Orama index 接口，用于 embedding 切换和手动重建。
  - 已提供后台 re-embed / rebuild index：维护服务按批量上限补齐缺失 embedding 并重建 Orama 内存索引；内部 API 和 WebUI 可手动触发，也可选择强制 re-embed。
  - 已提供最近一次 retrieval debug report，便于解释候选数量、索引数量、选中数量和失败原因。
  - `sensitivity=secret` 已从 prompt-facing facts 和 search documents 中排除。
  - 已提供保守的显式 fact candidate 抽取，只处理用户明确说“记住...”的当前触发用户消息。
  - 手动设置 `supersededBy` 时会自动把条目标记为 `superseded`，并在未显式设置 `validTo` 时自动写入失效时间。
- 阶段 3 已完成基础项：
  - 内部 API 和 WebUI 可列出、过滤、删除、pin/unpin、编辑 context items。
  - WebUI 编辑入口可维护 title、text、retrievalPolicy、status、sensitivity、validTo、supersededBy。
  - WebUI 已展示 context store、embedding、raw message 和 embedding 数量状态。
  - WebUI 已提供批量删除、压缩当前用户旧片段、清理已删除项、清空 embedding、重置索引入口。
  - 内部 API 和 WebUI 已提供 context items JSONL 导入/导出；导入导出不包含 embedding，向量由当前 profile 重建。
  - 批量删除接口要求至少一个过滤条件，避免误删全量 context items。
  - 已提供 `.remember <内容>` 和 `.forget <memoryId>` 聊天命令，分别写入和删除当前用户 fact。
- 阶段 4 已完成基础项：
  - 已固化召回评测样例和通过标准，见 `docs/development/user-context-retrieval-evaluation.md`。
  - 已记录当前 Orama 合成容量曲线和迁移阈值。

尚未完成：

- 暂无第一阶段阻断项。后续可按真实数据继续补充召回评测集和容量曲线。

### 阶段 0：POC 验证

已完成 Orama POC：

- `poc/user-context-hybrid-retrieval-orama`
- 验证 Orama hybrid search。
- 验证中文 bigram tokenizer。
- 验证用户过滤、recency、summary bonus、近重复抑制。

### 阶段 1：项目内最小闭环

- 新增 context types 和 store。
- 新增 Orama index adapter。
- 新增 embedding 模型类型和 provider adapter。
- 新增 instance 级 embedding profile 配置。
- 新增 scope、sourceType、retrievalPolicy、sensitivity、validity 字段。
- 将当前用户相关消息写入 raw。
- 迁移旧 `users[].memories` 到 `context_items` facts。
- 异步生成 chunk 和 embedding。
- prompt 构建阶段注入 `retrieved_context`。
- 语义检索暂停或失败时直接注入 `retrievalPolicy=always` 的用户 facts。
- 确保每个 instance 的 context 存储、索引和维护任务完全隔离。

### 阶段 2：分层和维护任务

- 增加 summary compaction。
- 增加 fact candidate 抽取。
- 增加 fact superseded / validTo 处理。
- 增加自动 GC。
- 增加依赖健康检查和 fallback。
- 增加 rebuild index。
- 增加 debug report。

### 阶段 3：手动管理

- 内部 API 管理 context items。
- WebUI 查看、搜索、删除、pin、编辑。
- WebUI 管理 scope、retrievalPolicy、sensitivity、有效期和替代关系。
- 用户聊天命令触发忘记和记住。
- 增加导出/导入。

### 阶段 4：评估和替换边界

- 固化召回评测样例。
- 记录 Orama 容量上限和性能曲线。
- 若热层规模超过 Orama 舒适区，迁移检索索引到 LanceDB、Qdrant 或 SQLite + sqlite-vec；canonical store 仍保留 SQLite。

## 风险与缓解

- 风险：临时信息误升为长期 fact。
  - 缓解：fact 提升保守，默认先 chunk/summary，fact 需要明确线索、重复确认或手动 pin。

- 风险：embedding 模型切换导致旧向量不可用。
  - 缓解：embedding profile 隔离，保留 canonical text，支持后台 re-embed。

- 风险：热层容量膨胀。
  - 缓解：配额、摘要化、归档、GC、active index 重建。

- 风险：新旧记忆双系统长期并存导致维护成本失控。
  - 缓解：迁移窗口内只保留旧工具名薄包装，数据和 prompt 只走新 `ContextStore`；迁移完成后删除旧字段和旧代码。

- 风险：用户边界泄漏。
  - 缓解：召回硬过滤 `userId`，测试覆盖跨用户隔离。

- 风险：敏感信息被 embedding 或摘要扩散。
  - 缓解：`sensitivity=secret` 默认不索引、不摘要、不进入 prompt；写入前做模式识别和用户显式拒绝保存处理。

- 风险：旧事实被新事实覆盖后无法追溯。
  - 缓解：使用 `validTo` 和 `supersededBy`，默认只注入 active，但保留历史链用于审计和恢复。

- 风险：Orama 内存索引不适合大规模。
  - 缓解：定位为第一阶段轻量索引，保留 retriever 抽象和替换空间。

- 风险：embedding 或索引依赖不可用影响主聊天链路。
  - 缓解：fail-open；依赖故障只禁用语义检索和新向量写入，不阻断普通聊天、工具调用、WebUI、OneBot。

- 风险：多个 instance 共享数据库或索引导致互相污染。
  - 缓解：所有 context 文件、embedding profile、Orama snapshot、maintenance job 都落在 `data/<instance>/context/`；内部 API、GC、reindex 均绑定当前 instance。

- 风险：不同 instance 使用不同 embedding 模型时向量空间混用。
  - 缓解：`embeddingProfileId` 包含 instance、provider、model、dimension、chunkerVersion；索引按 profile 和 instance 分开构建。

- 风险：用户不知道系统记住了什么。
  - 缓解：WebUI 管理、聊天命令、可解释 debug、导出/删除能力。

## 验收标准

第一阶段完成标准：

- 开启后，当前用户历史相关 chunk 能自动召回并注入 prompt。
- embedding 或 Orama 不可用时，普通聊天和核心 facts/rules 注入行为不被阻断。
- 旧 `user_memories` 已迁移为新 facts，旧字段不再作为独立数据源。
- 可重建 Orama index。
- 可切换 embedding profile 并重新索引。
- 每个 instance 的 context 数据库、embedding profile、Orama snapshot 完全独立。
- 自动 GC 至少能把旧 chunk 摘要化并归档。
- embedding 模型作为模型系统的 `embedding` 类型接入，并支持 provider adapter。
- WebUI 或内部 API 至少能列出、删除、pin context items。
- 测试覆盖跨用户隔离、scope 过滤、retrievalPolicy 降级、GC pinned 保护、sensitivity、superseded、embedding profile 维度变化。
