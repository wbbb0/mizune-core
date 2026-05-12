# Data Model Driven Data Registry

## 背景

当前 Data 页已经不再只是读取旧 JSON 文件，而是通过 Data Registry 暴露多个 SQLite-backed 资源。这个方向解决了“数据入口分散”的问题，但仍有几个结构性限制：

- Data Registry 资源大多按业务对象手写注册，后续新增表或拆表时需要同步维护 store、registry、WebUI 展示和测试。
- Data 页仍依赖 `src/data/schema` 导出的 `schemaMeta` / `rowSchemaMeta` / `uiTree` 来生成编辑 UI。这套 schema 最初更接近配置文件 schema，不适合长期承担 SQL 表、关系、索引和管理页面定义。
- SQLite schema 当前分散在各 store 的手写 SQL 中。表结构、校验逻辑、Data Registry metadata 和 WebUI 展示语义是重复表达的。
- 为了把存储改成更原生的 SQL 表结构，需要一个统一定义层来降低拆表成本，否则每次拆 JSON 字段都会带来较多样板代码。

目标不是把 Data 页退化为“纯数据库表浏览器”，也不是一次性实现完整 ORM。更合适的方向是：引入一个 data model 定义层，让数据库结构、表关系和 Data 管理页面都从同一份定义生成。

## 目标

- 用声明式 data model 定义 SQLite 数据域、表、列、索引、外键、表组和 Data 页展示关系。
- Data 页按 data model 生成管理页面，而不是只按业务 schema 或纯数据库元信息展示。
- 支持父子表管理体验，例如 Session 列表点开后显示对应的 transcript item 清单。
- 尽量减少不必要的 raw JSON 存储：稳定结构用原生列或竖表，异构 payload 才保留最小 JSON。
- 将现有 `src/data/schema` 的职责逐步收缩到配置文件、配置模板和 Config 页表单，最终移动到 `src/config/schema` 或等价包名下。
- 通过 Session 数据域做第一版 POC，边实现边校准 data model 抽象，再迁移其他数据域。

## 非目标

- 不实现通用 ORM，不提供复杂 query builder、关系懒加载或跨数据库抽象。
- 不让 Data 页默认绕过业务 store 随意写 source-of-truth 数据。
- 不承诺完全消除 JSON 字段。高度异构、低频或第三方原始结构仍可以保留 JSON payload。
- 不在第一阶段自动推断所有 UI 语义。SQLite metadata 能提供列和关系，不能可靠表达标题列、默认排序、详情布局和危险编辑行为。
- 不在第一阶段提供全自动破坏性 migration。生产 source-of-truth 表结构变更仍需要显式策略。

## 核心判断

用 Session 做 POC 是合适的。

原因：

- Session 现在已经有主表 `sessions` 和子表 `session_transcript_items`，正好能验证父子表管理页面。
- Session 高频写入，能验证“原生列 + 竖表 + payload JSON”的边界是否合理。
- Session Data 页对可读性有直接收益，容易人工验收。
- Session 数据结构复杂但范围集中，可以暴露抽象问题，又不会一次牵连所有数据域。
- 如果 data model 连 Session 都描述不好，就不应该贸然迁移 state、assets 或 context。

风险也可控：

- 第一版可以只做只读管理体验，不改变现有 session store 写入路径。
- 可以先让 data model 生成 Data Registry 和 WebUI metadata，再逐步接管 SQL DDL。
- 不需要一开始迁移所有 session JSON 字段，只需要验证父子表、列展示、过滤和 payload 展示。

## 设计原则

### 结构定义和业务逻辑分离

Data model 描述“数据如何存储和管理”，store 描述“业务如何读写和维护不变量”。

Data model 可以生成：

- `CREATE TABLE`
- index / foreign key SQL
- schema validation
- table group owned tables / indexes
- Data Registry resource metadata
- Data 页列表、详情、子表、过滤、默认排序

Store 仍负责：

- 业务对象组装
- 写入时的业务校验
- 运行时 side effect
- 复杂事务
- 与上层服务的接口稳定性

### SQL 原生优先

字段选择遵循以下顺序：

1. 需要查询、排序、过滤、聚合的字段必须是原生列。
2. 高频更新字段必须拆成原生列或独立竖表，避免重写大 JSON。
3. 稳定数组应拆成子表，例如 session transcript、scheduled job targets、Comfy result files。
4. 异构 payload 可以保留 JSON，但必须配套足够的索引列。
5. 第三方原始结构可以保留 JSON snapshot，不强行拆成不可维护的表。

### 自动化生成，但允许少量 UI hints

SQLite 可以自动提供：

- 表名
- 列名
- SQL 类型
- nullable
- primary key
- foreign key
- indexes

但它不能可靠提供：

- 哪个列适合做列表标题
- 哪个时间列用于默认排序
- 哪些子表应该嵌入详情页
- 哪些字段可编辑
- 哪些 JSON payload 应该以消息、文件或日志方式展示

因此 data model 需要少量 UI hints。目标是“结构自动，语义声明式”，不是“完全零声明”。

## 模块边界

建议新增：

```text
src/data/model/
  definition.ts
  columns.ts
  sqlGenerator.ts
  sqliteIntrospection.ts
  registryGenerator.ts
  uiMetadata.ts
  migrations.ts
```

长期目标：

```text
src/config/schema/
  base.ts
  primitives.ts
  composites.ts
  file.ts
  ui.ts
```

调整后职责：

- `src/data/model`：SQL table model、关系、DDL、Data Registry 和 Data 页 metadata。
- `src/data/registry`：资源运行时注册、分页、导出、行操作分发。
- `src/config/schema`：配置解析、配置模板、Config 页表单 metadata。
- 各业务 store：业务读写接口和 transaction 逻辑。

`src/data/schema` 在迁移完成后应消失，或只留下兼容期转发；默认不长期保留兼容层。

## Data Model 定义草案

示意 API：

```ts
export const sessionsDataDomain = defineDataDomain({
  database: "sessions",
  tableGroups: [
    {
      id: "sessions.persisted_sessions",
      schemaVersion: 4,
      resetPolicy: "reset_allowed",
      tables: ["sessions", "session_transcript_items"]
    }
  ],
  tables: {
    sessions: defineTable({
      groupId: "sessions.persisted_sessions",
      columns: {
        session_id: text().primaryKey(),
        display_name: text().nullable(),
        created_at_ms: integer().notNull(),
        updated_at_ms: integer().notNull(),
        last_message_at_ms: integer().nullable(),
        message_count: integer().notNull().default(0),
        pending_message_count: integer().notNull().default(0),
        last_llm_total_tokens: integer().nullable()
      },
      indexes: [
        index("idx_sessions_updated_at").on("updated_at_ms"),
        index("idx_sessions_last_message_at").on("last_message_at_ms")
      ],
      ui: {
        title: "Sessions",
        shape: "collection",
        defaultSort: [{ column: "updated_at_ms", direction: "desc" }],
        identity: ["session_id"],
        list: {
          titleColumn: "display_name",
          fallbackTitleColumn: "session_id",
          subtitleColumns: ["session_id"],
          badgeColumns: ["message_count", "pending_message_count"],
          timeColumn: "updated_at_ms"
        },
        detail: {
          sections: [
            { title: "Overview", columns: ["session_id", "display_name", "created_at_ms", "updated_at_ms"] },
            { title: "Runtime", columns: ["message_count", "pending_message_count", "last_llm_total_tokens"] }
          ],
          children: ["session_transcript_items"]
        }
      }
    }),

    session_transcript_items: defineTable({
      groupId: "sessions.persisted_sessions",
      columns: {
        session_id: text().notNull().references("sessions", "session_id").onDeleteCascade(),
        item_index: integer().notNull(),
        item_id: text().notNull(),
        group_id: text().nullable(),
        kind: text().notNull(),
        role: text().nullable(),
        llm_visible: booleanInt().notNull(),
        runtime_excluded: booleanInt().notNull(),
        timestamp_ms: integer().nullable(),
        item_hash: text().notNull(),
        item_json: jsonText().notNull(),
        updated_at_ms: integer().notNull()
      },
      primaryKey: ["session_id", "item_id"],
      indexes: [
        index("idx_session_transcript_items_session_index").on("session_id", "item_index"),
        index("idx_session_transcript_items_kind_time").on("kind", "timestamp_ms")
      ],
      ui: {
        title: "Transcript",
        shape: "child_collection",
        parent: {
          table: "sessions",
          localColumns: ["session_id"],
          parentColumns: ["session_id"]
        },
        defaultSort: [{ column: "item_index", direction: "asc" }],
        list: {
          titleColumn: "kind",
          subtitleColumns: ["role", "item_id"],
          timeColumn: "timestamp_ms",
          payloadColumn: "item_json"
        },
        detail: {
          payloadColumns: ["item_json"]
        }
      }
    })
  }
});
```

这个 API 不要求第一版完全实现，但可以作为设计边界。

## 生成内容

### 1. SQL DDL

由 table model 生成：

- `CREATE TABLE IF NOT EXISTS`
- `CREATE INDEX IF NOT EXISTS`
- `CHECK`
- `PRIMARY KEY`
- `FOREIGN KEY`
- `DEFAULT`
- `NOT NULL`

Store 不再手写重复 DDL，而是调用：

```ts
createDomainSchema(db, sessionsDataDomain);
validateDomainSchema(db, sessionsDataDomain);
```

### 2. Table Group Metadata

由 data domain 生成 `SqliteTableGroupDefinition[]`：

```ts
export const SESSION_TABLE_GROUPS = createTableGroupsFromDomain(sessionsDataDomain);
```

这样 `ownedTables` 和 `ownedIndexes` 不再手写同步。

### 3. Data Registry Resource

由 table UI metadata 生成 resource：

- resource key
- title
- storage database / table group / tables
- row identity
- parent-child relation
- default sort
- supported filters
- readonly/editable policy
- export policy

业务对象视图仍可存在，但应标记为 `view`：

- `sessions` 原生表 resource
- `session_transcript_items` 原生子表 resource
- `persisted_session_view` 可选，只读业务聚合视图

### 4. WebUI 管理页面

Data 页不再只根据 `rowUiTree` 生成表单，而是根据 data model UI metadata 生成：

- 资源列表
- 主表分页列表
- 行详情
- 子表 tabs / sections
- 子表按父行自动过滤
- payload JSON 只读展开
- 基础列过滤
- 外键跳转

Session POC 的目标体验：

1. Data 页选择 `Sessions`。
2. 显示 session 清单，按更新时间倒序。
3. 点击 session。
4. 右侧或详情页显示 session 元数据。
5. 下方显示 `Transcript` 子表，自动过滤当前 `session_id`。
6. transcript item 以消息清单形式展示 `kind`、`role`、`timestamp`、`llm_visible`。
7. 点击 transcript item 展示 `item_json` payload。

## 编辑策略

第一阶段默认只读。

后续编辑分三类：

- 原生安全编辑：单表、无 side effect、字段约束清晰，例如 whitelist、rules。
- Store-mediated 编辑：必须走业务 store，例如 scheduled jobs、sessions。
- 禁止编辑：runtime snapshots、audit log、transcript payload、context maintenance jobs。

Data model 只声明编辑能力，不直接决定所有写入路径：

```ts
edit: {
  mode: "readonly" | "native_single_row" | "store_adapter",
  adapterKey?: "scheduledJobStore"
}
```

这样可以避免 Data 页绕过业务不变量。

## JSON 字段治理

### 应优先拆的 JSON

- 数组型稳定结构：拆子表。
- 高频更新结构：拆列或拆表。
- Data 页需要过滤/排序的字段：拆列。
- 审计/状态里稳定顶层字段：拆列，原始结果可选保留 payload。

### 可以保留的 JSON

- 第三方原始 payload：例如 Comfy workflow graph。
- 高度异构事件 body：例如 transcript item payload。
- 低频、只用于人工排查的 debug envelope。

### 保留 JSON 的要求

保留 JSON 时，应同时提供：

- `kind` / `type`
- `status`
- `timestamp_ms`
- 关联 ID
- hash 或 size
- 常用 filter 字段

这样 Data 页和查询路径不需要依赖 JSON extraction。

## Session POC 范围

第一版只处理 `sessions/sessions.sqlite` 的 persisted sessions 表组。

包含：

- 为 `sessions` 和 `session_transcript_items` 定义 data model。
- 用 data model 生成 Data Registry resources。
- 用 data model 生成 Session `CREATE TABLE`、index、schema validation 和 table group metadata。
- WebUI Data 页支持 parent-child resource。
- Session 清单和 transcript 子表达到可用体验。
- 现有 `SessionPersistence` 读写路径尽量不变，降低风险。

暂不包含：

- 迁移所有 session JSON 字段。
- 给 transcript payload 做复杂富文本渲染。
- 原生编辑 session/transcript。
- 迁移 state/assets/context 其他数据域。
- 移动 `src/data/schema`。

第一版 POC 采用 Session-first：data model 同时生成 Data Registry / WebUI metadata 和 Session 表组 DDL / validation。业务读写 SQL 暂时保留在 `SessionPersistence` 中，避免在定义器形状还在校准时把运行时读写路径也改成通用 query builder。

## Session POC 验收标准

- `npm run typecheck:all` 通过。
- `npm run test` 通过。
- Data Registry resource metadata 由 session data model 生成，而不是在 `dataRegistryService.ts` 重复手写表、列和关系。
- `SessionPersistence` 的 DDL、index、schema validation 和 table group metadata 由 session data model 生成。
- `sessions` 详情页能展示 `session_transcript_items` 子表。
- 子表查询必须在 SQL 层按 `session_id` 过滤，不能前端全量过滤。
- Data 页无需 session 专属硬编码即可展示主从关系；允许使用 data model 的 UI hints。
- 当前 Sessions 业务页不受影响。
- `SessionPersistence` 的存储 round-trip 测试覆盖主表和 transcript 子表。

## 迁移路线

### 阶段 1：Session POC

新增 `src/data/model` 最小能力：

- column definitions
- table definitions
- index definitions
- foreign key definitions
- table group generation
- registry metadata generation
- parent-child UI metadata

先迁移 session registry 资源和 Session DDL / validation，不改业务读写 SQL。

### 阶段 2：Session Query Helper

在 Session POC 稳定后，为 data model 增加有限 query helper，让列表、详情和子表过滤也能从 model 派生。

目标：

- 删除 `listSessionRows` / `listTranscriptRows` 中重复的 select/order/filter 样板。
- 支持基于 model 的安全 filter 白名单。
- 不把 store 改成完整 ORM。

### 阶段 3：Data 页通用主从管理

WebUI Data 页改成基于 resource relation metadata：

- collection list
  - 清单列优先来自字段定义上的 `primary: true`
  - 列宽默认由 role 派生；特殊列可通过 `listWidth: "xs" | "sm" | "md" | "lg" | "xl"` 或 CSS grid track 覆盖
  - 非 primary 且非 hidden 的字段默认只出现在详情视图
  - `list.columns` 仅作为未迁移模型的显式 fallback / override
- row detail
- child collection tabs
- SQL-level child filtering
- payload viewer

先保证 session 体验，再决定是否替换其他手写 Data 资源视图。

### 阶段 4：迁移其他数据域

按收益排序：

1. scheduled jobs：已有主从表，适合验证可编辑 store adapter。
2. Comfy tasks：已有 result files 子表，适合验证 assets 域和只读 payload。
3. chat files：适合拆 `source_context_json`。
4. content safety audits：适合拆稳定 result 字段。
5. context raw messages：适合验证 segments/attachments 子表是否值得拆。

### 阶段 5：收缩并移动 config schema

当 Data Registry 和 Data 页不再依赖 `schemaMeta` / `rowUiTree` 后：

- 将 `src/data/schema` 移到 `src/config/schema`。
- 更新 config/editor 相关 import。
- 业务模块不再从 config schema 推导 data registry UI。
- 对仍需 runtime validation 的业务对象，保留模块本地 schema 或轻量 parser。

## Effort 评估

### Session POC

中等工作量，可控。

主要改动：

- 新增 data model 基础定义器。
- session table model。
- registry 生成器。
- Data 页 child collection 展示。
- session 相关测试。

风险：

- UI metadata 过早抽象过度。
- Data Registry 旧 resource 和新 generated resource 并存时命名冲突。

控制方式：

- 只覆盖 sessions。
- 第一版只读。
- UI hints 保持小而明确。

### 全量 data model 迁移

较大工作量，需要分批。

原因：

- 各 store 现在有不同的读写模式。
- 一些表组使用 `block_reset`，不能随意自动重建。
- context/session/assets/state 的数据形态差异很大。

控制方式：

- 每次迁移一个 table group。
- 先生成 registry，再接管 DDL，再考虑拆 JSON。
- 每个 table group 都有独立测试。

### config schema 移动

中等工作量，依赖前置工作。

如果现在直接移动，会牵动很多业务 schema import，收益不够直接。等 Data 页摆脱 `rowSchemaMeta` 后再移动更稳。

## 替代方案比较

### 方案 A：纯数据库表浏览器

优点：

- 实现最快。
- 不需要定义 UI hints。

缺点：

- 管理体验差。
- Session/transcript 这类主从关系不自然。
- 后续仍要手写业务视图。

结论：不推荐作为主方向，只适合作为 debug fallback。

### 方案 B：继续手写 Data Registry resource

优点：

- 短期改动小。
- 每个资源体验可以定制。

缺点：

- 后续维护成本高。
- 拆表时需要同步多处。
- 无法解决 schema/SQL/UI 重复表达。

结论：适合临时补洞，不适合作为长期结构。

### 方案 C：引入完整 ORM 或 migration 框架

优点：

- DDL/migration 能力成熟。

缺点：

- 当前项目已经有较多 SQLite service/table group 语义。
- ORM 抽象可能掩盖 source-of-truth reset policy。
- Data 页管理语义仍需要另写。

结论：暂不推荐。可以借鉴思想，不引入重型依赖。

### 方案 D：项目内 data model 定义器

优点：

- 贴合现有 SQLite service 和 table group。
- 能统一 SQL、registry、Data UI。
- 可以按 table group 渐进迁移。
- 不强迫 store 改成 ORM。

缺点：

- 需要自己维护定义器。
- 初期边界需要通过 POC 校准。

结论：推荐。

## 决策建议

下一步先做 Session POC，不迁移其他数据域。

POC 应证明三件事：

1. data model 能减少 SQL/schema/registry/UI 的重复定义。
2. Data 页能根据主从关系自动生成比表浏览器更自然的管理体验。
3. 保留少量 JSON payload 与“尽量原生 SQL”并不冲突。

POC 完成并验证后，再决定：

- data model API 是否稳定。
- 是否接管 session DDL。
- 哪些现有 JSON 字段值得下一批拆。
- 何时开始移动 `src/data/schema` 到 config 包。
