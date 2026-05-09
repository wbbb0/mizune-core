# SQLite 存储架构

本项目的 SQLite 基础设施采用“数据库文件 + 表组”的两层模型：

- 数据库文件负责打开、pragma、完整性检查和文件级自愈。
- 表组负责声明一组业务表、索引、schema 版本、依赖关系和结构校验。

通用实现位于 `src/data/sqlite/sqliteService.ts`。业务模块不直接负责打开 SQLite 文件，而是注册 `SqliteTableGroupDefinition` 后取得数据库句柄。

## 表组版本策略

每个表组都有独立的 `groupId` 与 `schemaVersion`。版本记录保存在通用元数据表 `__sqlite_schema_groups` 中。

当代码中的表组版本与数据库元数据不一致时，通用层默认会只重置该表组及依赖它的下游表组：

1. 关闭外键检查。
2. 按依赖反向顺序删除这些表组拥有的索引和表。
3. 按依赖顺序重新创建 schema。
4. 写入新的表组版本和重置原因。
5. 恢复外键检查。

这意味着数据结构发生破坏性变化时，不做兼容迁移；该表组旧数据直接失效。但其他无关表组不会被清空。

表组可以通过 `resetPolicy` 调整这一行为：

- `reset_allowed`：默认策略，允许版本不匹配或结构校验失败时自动 drop/recreate 表组。
- `block_reset`：用于未来作为真实数据源的表组。全新空库仍允许建表；一旦该表组已经有元数据、表或索引，任何会删除它的版本不匹配、结构校验失败或上游依赖重置都会直接报错，不会删除旧表。

`block_reset` 不提供自动迁移能力。需要修改 source-of-truth 表结构时，应先实现显式迁移或由维护者手动清空新库后再启动。

包含 `block_reset` source-of-truth 表组的数据库不应开启文件级自动重建。文件级 open/integrity 自愈会隔离整个 SQLite 文件并创建空库，这会绕过表组级保护；因此 `state/state.sqlite` 这类真实数据源在数据库打不开或完整性校验失败时应直接启动失败，等待人工恢复。

如果旧数据库还没有 `__sqlite_schema_groups` 元数据，表组可以提供 `adoptExistingSchema` 做一次性接管准备。这个钩子只用于把接入表组机制之前已经由当前代码支持的 SQLite 文件补齐到当前结构，例如补齐历史上已存在的非破坏列；它不是未来 schema 版本变更的迁移机制。已有元数据后，后续结构变化必须通过提升表组版本触发失效重建。

## 依赖传播

表组可以通过 `dependsOn` 声明依赖。父表组被重置时，依赖它的表组也会一起重置。

例如 `context.embeddings` 依赖 `context.items`。当 `context.items` 的结构版本变化时，embedding 数据会随之失效；单独更新 embedding 结构时，不会影响 context item。

## 文件级自愈

表组自愈只处理结构层问题。以下情况属于数据库文件级问题，会隔离整个 SQLite 文件并新建空库：

- 数据库打不开。
- `PRAGMA integrity_check` 失败。
- SQLite 报告文件不是数据库或镜像损坏。

被隔离的 `.sqlite`、`.sqlite-wal`、`.sqlite-shm` 会移动到同目录下的 `invalid/`，用于人工排查。

## Context Store 表组

当前 `ContextStore` 注册了四个表组：

- `context.raw_messages`：`raw_messages`
- `context.items`：`context_items`、`context_item_sources`
- `context.embeddings`：`context_item_embeddings`、`embedding_profiles`，依赖 `context.items`
- `context.maintenance`：`maintenance_jobs`、`manual_audit_events`

旧版没有 `__sqlite_schema_groups` 元数据的数据库会先按当前 schema 校验；校验通过则接管并写入表组元数据，校验失败则只重置失败的表组。
其中 `context.items` 和 `context.embeddings` 会在无元数据接管时补齐旧实现已经支持的 `slot_key`、`embedding_text_hash`、`text_hash` 列，避免把升级到表组机制本身误判为业务结构失效。
