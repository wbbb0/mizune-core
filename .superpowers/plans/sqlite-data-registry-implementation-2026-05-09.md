# SQLite data registry implementation plan

## Scope

把 `data/` 下需要长期保留、需要 WebUI 查看或编辑的数据逐步收敛到 SQLite，并建立一个后端统一注册、前端自动生成列表和编辑界面的 data registry。

本次变更不做旧数据迁移。旧 JSON / YAML / loose files 视为失效数据，迁移到新结构后不提供导入、兼容读取、双读双写或字段级 fallback。确实需要保留的导出能力只面向新 SQLite 数据，以稳定文件名覆盖上一次 dump。

`webui/` 需要支持新 data 页能力，但不把前端作为第一阶段的数据结构来源；表定义、schema、可编辑性和导出能力都以后端 registry 为准。

## Progress

当前进度截至 `1a6fd1f migrate scenario host state to sqlite`。

已完成：

- [x] 建立 `.worktrees/sqlite-data-registry` 开发分支和本计划。
- [x] 接入 SQLite table group reset policy，并保留 `block_reset` 保护真实数据表组。
- [x] 建立 Data Registry 后端 skeleton、schema metadata、row API 和 WebUI registry mode。
- [x] 迁移 `persona`、`whitelist` 到 `state/state.sqlite`。
- [x] 迁移 `rp_profile`、`scenario_profile`、`global_profile_readiness`、`setup_state` 到 `state/state.sqlite`。
- [x] 迁移 `users`、`user_memories` 到 `state/state.sqlite`，运行时不再读取旧 `users.json`。
- [x] 迁移 `pending_requests` 到 `state/state.sqlite`，运行时不再读取旧 `pending-requests.json`。
- [x] 迁移 `scheduled_jobs` 到 `state/state.sqlite`，运行时不再读取旧 `scheduled-jobs.json`。
- [x] 迁移 runtime resources 到 `state/state.sqlite`，并通过 Data Registry 暴露 `live_resources`。
- [x] 将 `context.sqlite` 的只读资源接入通用 Data Registry 查看。
- [x] 迁移 `sessions` 到 `sessions/sessions.sqlite`，运行时不再读取旧 `sessions/*.json`。
- [x] 迁移 `scenario_host` per-session state 到 `sessions/sessions.sqlite`，运行时不再读取旧 `scenario-host/sessions/*.json`。
- [x] 为 registry collection 增加 `rowOperations`，前端只在后端支持时展示新增、编辑和删除入口。
- [x] 每个已完成切片均已拉起 5.5 medium 子 agent 审查，并处理阻断/中高风险问题。

尚未完成：

- [x] `global_rules` / `toolset_rules`：配置型规则数据已迁移到 `state.sqlite`。
- [x] `user_identities`：已迁移到 `state.sqlite.user_identities`。
- [x] `group_membership`：已迁移到 `state.sqlite.group_membership_entries`，仍按 cache durability 暴露。
- [x] `sessions`：已迁移到 `sessions/sessions.sqlite`。
- [x] `scenario_host` per-session state：已迁移到 `sessions/sessions.sqlite.scenario_host_session_states`。
- [ ] `audio_files` / chat file indexes / workspace file indexes / Comfy tasks / content safety audit：仍是文件型或整文件写，后续归入 `assets.sqlite` 或单独表组。
- [x] stable dump/export writer：registry 可导出资源写入 `dumps/<resource>.json`，同名覆盖。
- [x] context read-only registry exposure：`context.sqlite` 已接入通用 Data Registry 查看。

当前工作分支提交：

- `983f9e1 Migrate core data registry to SQLite`
- `ffd8a71 Migrate profile setup data to SQLite`
- `3ef3ce9 Migrate users to SQLite data registry`
- `7ba6613 Migrate pending requests to SQLite`
- `d7fc9be Migrate scheduled jobs to SQLite`
- `f6f9ab3 Migrate runtime resources to SQLite data registry`
- `65ffa80 migrate session persistence to sqlite`
- `1a6fd1f migrate scenario host state to sqlite`

## Goals

- 降低磁盘重复写压力：配置型和运行态数据使用行级更新，不再把大对象序列化成整个文件反复覆盖。
- 后端统一注册数据项：新增一个 data resource 后，WebUI data 页自动出现对应条目。
- 区分可编辑和只读资源：配置型数据可编辑，日志、缓存、运行快照默认只读或仅查看。
- 尽量使用规范 SQL 表，不把可查询、可编辑的主体数据塞进单个 JSON 字段。
- dump 文件稳定命名，同类数据导出覆盖上一份 dump，避免 dump 文件爆炸。
- 临时队列类数据默认不持久化，例如 `session_pending_messages`、`pendingSteerMessages`、`pendingInternalTriggers`。

## Non-goals

- 不迁移旧 data 文件。
- 不保留旧 data browser 的写入兼容路径。
- 不为历史 SQLite schema 写迁移脚本。
- 不在本轮把 config 系统改造成 registry；只关注 `data/`。
- 不在集合型资源上提供整表替换式保存。
- 不持久化临时 pending 队列，包括 `pendingMessages`、`pendingSteerMessages`、`pendingInternalTriggers`。

## Review Corrections

第一轮子 agent 审查后修正以下执行约束：

- SQL 表必须贴合当前领域模型，不能借本轮迁移把单例资料改成多 profile 模型。
- `persona`、`rp_profile`、`scenario_profile` 先按当前单例 schema 存储。
- `global_profile_readiness`、`setup_state` 属于明确需要人工干预的 singleton data resource。
- `pendingMessages` 这类短生命周期队列不落库；sessions 表不包含 pending queue。
- 旧 data endpoint 最多短期转发到 registry，不继续以旧 JSON 文件作为 data source of truth。
- 每个现有 Data 页资源必须明确归类为 SQL 化、只读 registry 暴露、保留文件型资源或不进入 registry。

## Database Layout

保留现有 `context/context.sqlite`，新增以下 SQLite 文件：

- `data/<instance>/state/state.sqlite`：人工可干预的配置型和运行状态数据。
- `data/<instance>/sessions/sessions.sqlite`：会话快照与 `scenario_host` 每会话状态，后续可继续承载会话相关结构化数据。
- `data/<instance>/assets/assets.sqlite`：文件索引、图片/音频元数据、生成任务引用等较大资产的索引信息。

大体原则：

- `state.sqlite` 适合 `persona`、`rp-profile`、rules、users、whitelist、scheduled jobs、requests、approval state 等。
- `sessions.sqlite` 适合 session metadata、summary、transcript event、`scenario_host` per-session state，以及其他明确属于会话域的结构化数据。
- `assets.sqlite` 只存索引和元数据，真实大文件仍可留在文件系统，避免 BLOB 让 DB 无限制膨胀。
- `context.sqlite` 继续承载已存在的 context/memory 相关表，除非后续单独重构。

## Data Registry Contract

新增 `src/data/registry/`，核心定义：

```ts
type DataResourceShape = "singleton" | "collection" | "log" | "file" | "directory";
type DataResourceDurability = "source_of_truth" | "cache" | "derived" | "ephemeral";

interface DataResourceDefinition<TValue = unknown, TRow = unknown> {
  key: string;
  title: string;
  description?: string;
  shape: DataResourceShape;
  editable: boolean;
  durability: DataResourceDurability;
  storage: {
    kind: "sqlite" | "file";
    database?: "state" | "sessions" | "assets" | "context";
    tableGroup?: string;
    tables?: string[];
    path?: string;
  };
  schema?: unknown;
  rowSchema?: unknown;
  rowIdentity?: {
    fields: string[];
    encode: "single" | "json_base64url";
  };
  childResources?: Array<{
    key: string;
    parentFields: string[];
    rowIdentity: {
      fields: string[];
      encode: "single" | "json_base64url";
    };
    editable: boolean;
  }>;
  ui?: {
    listColumns?: string[];
    defaultSort?: string;
    filters?: unknown[];
  };
  export?: {
    enabled: boolean;
    fileName: string;
    format: "json" | "jsonl" | "yaml" | "csv" | "markdown";
  };
  adapter: DataResourceAdapter<TValue, TRow>;
}
```

约束：

- `singleton` 可以整体 `PATCH`，用于单对象配置。
- `collection` 必须走 row API，禁止整集合保存。
- `log` 默认只读，可分页、筛选、导出。
- `file` / `directory` 仅用于保留少量还没 SQL 化或本来就应以文件存在的数据。
- `editable=false` 的资源前端只显示查看器和导出入口。
- `schema` / `rowSchema` 由后端注册，前端只消费 schema metadata 自动生成界面。
- 复合主键使用 `rowIdentity.fields` 描述，URL 中的 `rowId` 使用稳定 JSON + base64url 编码。
- 父子表编辑必须由后端 adapter 在一个事务内完成，避免半更新。
- 删除父行时必须由 resource definition 明确 `restrict` 或 `cascade`，默认 `restrict`。

## API Plan

新增或替换 internal API data 路由：

```http
GET    /api/data/resources
GET    /api/data/resources/:key
PATCH  /api/data/resources/:key
GET    /api/data/resources/:key/rows
GET    /api/data/resources/:key/rows/:rowId
POST   /api/data/resources/:key/rows
PATCH  /api/data/resources/:key/rows/:rowId
DELETE /api/data/resources/:key/rows/:rowId
POST   /api/data/resources/:key/export
```

行为：

- `GET /resources` 返回资源目录、形态、可编辑性、schema 摘要、导出能力。
- `collection` 列表支持分页、排序、过滤，默认不一次性读全表。
- `PATCH row` 使用固定 envelope：`{ patch, revision?, updatedAt? }`。`patch` 是字段级更新，`revision` / `updatedAt` 用于并发保护。
- `export` 写入稳定 dump 路径，例如 `data/<instance>/dumps/persona.json`，同名覆盖。
- 对 `ephemeral` 资源不提供 export 和编辑。
- dump 必须原子写：先写同目录临时文件，再 rename 覆盖。
- dump 输出必须确定性排序；同一数据连续导出应产生相同字节。
- dump 文件名来自后端 definition，禁止用户输入路径，禁止逃出 `dumps/`。

## Table Design

### state.sqlite

#### persona

当前业务模型是全局单例，不做多 persona profile 设计。

- `persona`
  - `id text primary key check (id = 'global')`
  - `name text not null default ''`
  - `temperament text not null default ''`
  - `speaking_style text not null default ''`
  - `global_traits text not null default ''`
  - `general_preferences text not null default ''`
  - `updated_at_ms integer not null`

#### rp-profile

当前业务模型是 RP 全局单例。

- `rp_profile`
  - `id text primary key check (id = 'global')`
  - `self_positioning text not null default ''`
  - `social_role text not null default ''`
  - `life_context text not null default ''`
  - `physical_presence text not null default ''`
  - `bond_to_user text not null default ''`
  - `closeness_pattern text not null default ''`
  - `interaction_pattern text not null default ''`
  - `reality_contract text not null default ''`
  - `continuity_facts text not null default ''`
  - `hard_limits text not null default ''`
  - `updated_at_ms integer not null`

#### scenario-profile

当前业务模型是 Scenario Host 全局单例。

- `scenario_profile`
  - `id text primary key check (id = 'global')`
  - `theme text not null default ''`
  - `host_style text not null default ''`
  - `world_baseline text not null default ''`
  - `safety_or_taboo_rules text not null default ''`
  - `opening_pattern text not null default ''`
  - `updated_at_ms integer not null`

#### global-profile-readiness

- `global_profile_readiness`
  - `id text primary key check (id = 'global')`
  - `persona text not null check (persona in ('uninitialized', 'ready'))`
  - `rp text not null check (rp in ('uninitialized', 'ready'))`
  - `scenario text not null check (scenario in ('uninitialized', 'ready'))`
  - `updated_at_ms integer not null`

#### setup-state

- `setup_state`
  - `id text primary key check (id = 'global')`
  - `state text not null check (state in ('needs_owner', 'needs_persona', 'ready'))`
  - `owner_prompt_sent_at_ms integer`
  - `updated_at_ms integer not null`

#### rules

- `rulesets`
  - `id text primary key`
  - `scope text not null`
  - `title text not null`
  - `enabled integer not null default 1`
  - `priority integer not null default 0`
  - `created_at text not null`
  - `updated_at text not null`
- `rules`
  - `id text primary key`
  - `ruleset_id text not null`
  - `kind text not null`
  - `matcher_type text not null`
  - `matcher_value text not null`
  - `effect text not null`
  - `content text not null default ''`
  - `enabled integer not null default 1`
  - `priority integer not null default 0`
  - `created_at text not null`
  - `updated_at text not null`

#### users

- `users`
  - `user_id text primary key`
  - `preferred_address text`
  - `gender text`
  - `residence text`
  - `timezone text`
  - `occupation text`
  - `profile_summary text`
  - `relationship_note text`
  - `special_role text check (special_role is null or special_role = 'npc')`
  - `created_at_ms integer not null`
- `user_legacy_memories`
  - `user_id text not null`
  - `memory_id text not null`
  - `content text not null`
  - `created_at_ms integer`
  - `primary key (user_id, memory_id)`

`user_legacy_memories` 只用于承载当前 `userStoreSchema.memories` 字段的结构化查看/编辑；长期记忆主存储仍由 context memory 管理。

#### whitelist

- `whitelist_entries`
  - `target_type text not null check (target_type in ('user', 'group'))`
  - `target_id text not null`
  - `created_at_ms integer not null`
  - `primary key (target_type, target_id)`

#### scheduled jobs

- `scheduled_jobs`
  - `id text primary key`
  - `name text not null`
  - `enabled integer not null default 1`
  - `created_at_ms integer not null`
  - `updated_at_ms integer not null`
  - `schedule_kind text not null check (schedule_kind in ('delay', 'at', 'cron'))`
  - `delay_ms integer`
  - `run_at_ms integer`
  - `cron_expr text`
  - `timezone text`
  - `instruction text not null`
  - `next_run_at_ms integer`
  - `last_run_at_ms integer`
  - `last_run_status text check (last_run_status is null or last_run_status in ('ok', 'error', 'running'))`
  - `last_duration_ms integer`
  - `last_error text`
  - `consecutive_errors integer not null default 0`
- `scheduled_job_targets`
  - `job_id text not null`
  - `session_id text not null`
  - `primary key (job_id, session_id)`

#### requests / approvals

- `pending_requests`
  - `id text primary key`
  - `kind text not null check (kind in ('friend', 'group'))`
  - `flag text not null`
  - `user_id text not null`
  - `group_id text`
  - `sub_type text check (sub_type is null or sub_type in ('add', 'invite'))`
  - `comment text not null default ''`
  - `created_at_ms integer not null`
  - `unique (kind, flag)`

#### group membership

- `group_membership_entries`
  - `group_id text not null`
  - `user_id text not null`
  - `is_member integer not null`
  - `verified_at_ms integer not null`
  - `primary key (group_id, user_id)`

#### global rules

- `global_rules`
  - `id text primary key`
  - `title text not null`
  - `content text not null`
  - `kind text not null check (kind in ('workflow', 'constraint', 'preference', 'other'))`
  - `source text not null check (source in ('owner_explicit', 'inferred'))`
  - `created_at_ms integer not null`
  - `updated_at_ms integer not null`

#### toolset rules

- `toolset_rules`
  - `id text primary key`
  - `title text not null`
  - `content text not null`
  - `fingerprint text not null`
  - `source text not null check (source in ('owner_explicit', 'inferred'))`
  - `created_at_ms integer not null`
  - `updated_at_ms integer not null`
- `toolset_rule_toolsets`
  - `rule_id text not null`
  - `toolset_id text not null`
  - `primary key (rule_id, toolset_id)`

#### runtime resources

- `runtime_resources`
  - `resource_id text primary key`
  - `kind text not null check (kind in ('browser_page', 'shell_session'))`
  - `status text not null check (status in ('active', 'expired', 'closed', 'unrecoverable'))`
  - `owner_session_id text`
  - `title text`
  - `description text`
  - `summary text not null`
  - `created_at_ms integer not null`
  - `last_accessed_at_ms integer not null`
  - `expires_at_ms integer`
- `runtime_browser_pages`
  - `resource_id text primary key`
  - `requested_url text not null`
  - `resolved_url text not null`
  - `backend text not null check (backend = 'playwright')`
  - `title text`
  - `profile_id text`
- `runtime_shell_sessions`
  - `resource_id text primary key`
  - `command text not null`
  - `cwd text not null`
  - `shell text not null`
  - `tty integer not null`
  - `login integer not null`

#### key-value fallback

- `state_kv`
  - `key text primary key`
  - `value_json text not null`
  - `updated_at text not null`

只允许用于短期无法合理表结构化的少量状态，不作为配置型数据默认方案。

### sessions.sqlite

- `sessions`
  - `session_id text primary key`
  - `type text not null check (type in ('private', 'group'))`
  - `source text not null check (source in ('onebot', 'web'))`
  - `mode_id text not null`
  - `operation_mode_json text not null`
  - `participant_kind text not null check (participant_kind in ('user', 'group'))`
  - `participant_id text not null`
  - `title text`
  - `title_source text check (title_source is null or title_source in ('default', 'auto', 'manual'))`
  - `reply_delivery text not null check (reply_delivery in ('onebot', 'web'))`
  - `pending_transcript_group_id text`
  - `active_transcript_group_id text`
  - `history_summary text`
  - `history_backfill_boundary_ms integer`
  - `last_active_at_ms integer not null`
  - `last_message_at_ms integer`
  - `latest_gap_ms integer`
  - `smoothed_gap_ms real`
- `session_messages`
  - `id text primary key`
  - `session_id text not null`
  - `seq integer not null`
  - `role text not null`
  - `sender_id text not null default ''`
  - `content_text text not null default ''`
  - `created_at text not null`
  - `unique (session_id, seq)`
- `session_message_segments`
  - `message_id text not null`
  - `segment_index integer not null`
  - `segment_type text not null`
  - `text_value text not null default ''`
  - `asset_id text not null default ''`
  - `payload_json text not null default '{}'`
  - `primary key (message_id, segment_index)`
- `session_summaries`
  - `session_id text primary key`
  - `summary_text text not null`
  - `source_message_seq integer not null default 0`
  - `updated_at text not null`
- `session_debug_markers`
  - `id text primary key`
  - `session_id text not null`
  - `kind text not null`
  - `timestamp_ms integer not null`
  - `literals_json text not null default '[]'`
  - `sent_count integer`
  - `note text`
- `session_llm_usage`
  - `session_id text primary key`
  - `input_tokens integer`
  - `output_tokens integer`
  - `total_tokens integer`
  - `cached_tokens integer`
  - `reasoning_tokens integer`
  - `request_count integer not null`
  - `provider_reported integer not null`
  - `model_ref text`
  - `model text`
  - `captured_at_ms integer not null`
- `session_sent_messages`
  - `session_id text not null`
  - `message_id integer not null`
  - `text text not null`
  - `sent_at_ms integer not null`
  - `primary key (session_id, message_id)`
- `transcript_events`
  - `id text primary key`
  - `session_id text not null`
  - `seq integer not null`
  - `event_type text not null`
  - `text_value text not null default ''`
  - `payload_json text not null default '{}'`
  - `created_at text not null`
  - `unique (session_id, seq)`

必须不落库：

- `pendingMessages`
- `pendingSteerMessages`
- `pendingInternalTriggers`
- debounce/timer/in-flight generation state

Session 迁移必须补 round-trip 测试：从 runtime state 保存到 SQLite 再加载，除明确不持久化字段外保持语义一致。

### assets.sqlite

- `assets`
  - `id text primary key`
  - `kind text not null`
  - `source text not null default ''`
  - `mime_type text not null default ''`
  - `path text not null`
  - `sha256 text not null default ''`
  - `size_bytes integer not null default 0`
  - `created_at text not null`
  - `updated_at text not null`
- `asset_references`
  - `asset_id text not null`
  - `owner_kind text not null`
  - `owner_id text not null`
  - `created_at text not null`
  - `primary key (asset_id, owner_kind, owner_id)`
- `generated_images`
  - `id text primary key`
  - `asset_id text not null`
  - `provider text not null default ''`
  - `prompt text not null default ''`
  - `workflow_id text not null default ''`
  - `status text not null`
  - `created_at text not null`
  - `updated_at text not null`
- `audio_records`
  - `id text primary key`
  - `asset_id text not null`
  - `duration_ms integer not null default 0`
  - `transcript_text text not null default ''`
  - `created_at text not null`
  - `updated_at text not null`

### context.sqlite

保留现有 context table groups。若 registry 需要暴露 memory/context，只先注册为只读 `log` 或 `collection`，不在本阶段重建 schema。

## Existing Data Resource Inventory

现有 Data 页资源必须按下表处理，避免“尽可能迁移”缺少验收边界。

| status | resource | target | registry shape | editable |
| --- | --- | --- | --- | --- |
| done | `persona` | `state.sqlite.persona` | `singleton` | yes |
| done | `rp_profile` | `state.sqlite.rp_profile` | `singleton` | yes |
| done | `scenario_profile` | `state.sqlite.scenario_profile` | `singleton` | yes |
| done | `global_profile_readiness` | `state.sqlite.global_profile_readiness` | `singleton` | yes |
| done | `setup_state` | `state.sqlite.setup_state` | `singleton` | no |
| done | `users` | `state.sqlite.users` + `state.sqlite.user_memories` | `collection` | yes |
| done | `whitelist` | `state.sqlite.whitelist_entries` | `collection` | yes |
| done | `requests` | `state.sqlite.pending_requests` | `collection` | yes |
| done | `scheduled_jobs` | `state.sqlite.scheduled_jobs` | `collection` | yes |
| done | `global_rules` | `state.sqlite.global_rules` | `collection` | yes |
| done | `toolset_rules` | `state.sqlite.toolset_rules` + child toolset rows | `collection` | yes |
| done | `user_identities` | `state.sqlite.user_identities` | `collection` | yes |
| done | `group_membership` | `state.sqlite.group_membership_entries` | `collection` | yes |
| pending | `live_resources` | `state.sqlite.runtime_resources` or `assets.sqlite.assets` refs | `collection` | no |
| pending | `audio_files` | `assets.sqlite.audio_records` + `assets` | `collection` | no |
| pending | `image_files` | `assets.sqlite.assets` + `generated_images` where applicable | `collection` | no |
| pending | `sessions` | `sessions.sqlite.sessions` + child message/transcript tables | `collection` | no in first pass |
| pending | `workspace_files` | `assets.sqlite.assets` with `source='workspace'` | `collection` | no in first pass |

额外 data-domain 资源：

- `scenario_host` per-session state：随 session 进入 `sessions.sqlite`，不作为全局 Data 页第一批可编辑资源。
- WebUI auth/session secret：如果当前落在 data 下，归入 `state.sqlite.webui_auth_state`，默认只读或管理 API 专用，不进入通用编辑器。
- chat/workspace/audio/image file index：归入 `assets.sqlite`；真实文件继续在文件系统。
- context memory：保留 `context.sqlite`，registry 先只读查看。

## Execution Steps

### Step 1: Worktree and plan

- [x] 创建 `.worktrees/sqlite-data-registry`。
- [x] 写入本计划。
- [x] 拉起 5.5 medium 子 agent 审查计划是否覆盖用户需求、是否存在明显高风险遗漏。

Acceptance:

- 主目录保持干净。
- 计划明确不做旧数据迁移。

### Step 2: SQLite table group reset policy

- [x] 扩展 `SqliteTableGroupDefinition`：
  - `resetPolicy?: "reset_allowed" | "block_reset"`。
- [x] 默认 `reset_allowed` 保持现有测试和缓存型数据行为。
- [x] `block_reset` 用于未来 `source_of_truth` 表组，避免运行中误删真实数据。
- [x] 本次不实现历史 schema migration；schema 不匹配时若策略阻止 reset，直接报错。
- [x] 对全新 DB 允许创建表，不视为 reset 破坏。
- [x] 更新 SQLite 架构文档和单元测试。

Acceptance:

- fresh DB 可以创建 `block_reset` 表组。
- 已存在且版本或 schema 不匹配的 `block_reset` 表组不会被 drop。
- 现有默认自动修复行为不变。

### Step 3: Data registry backend skeleton

- [x] 新增 `src/data/registry/` 类型、注册器、schema metadata 转换、adapter interfaces。
- [x] 新增 internal API registry routes，当前挂到 `/api/data/registry/*`。
- [x] data-domain editor resources 逐步从 registry 接管；已迁移资源从旧 JSON editor 移除。
- [x] 未 SQL 化但必须保留的文件型资源以 `file` / `directory` 注册，并标记 `durability`。
- [ ] stable dump writer 仍未实现。

Acceptance:

- 后端可以列出 registry resources。
- singleton 和 collection route skeleton 有测试覆盖。
- 不发生整集合保存。
- 不可编辑资源写入返回 403 或 400。
- `ephemeral` 资源不可 export。
- row list query 会向 adapter 传递分页、排序和过滤参数。
- row patch route 使用 `{ patch, revision?, updatedAt? }`，不接受整行裸 value。
- export route 存在并拒绝未启用导出的资源。

### Step 4: WebUI data page registry mode

- [x] Data 页接入 `/api/data/registry/resources` 获取 registry 资源目录。
- [x] 根据 `shape` 分派：
  - `singleton_form`
  - `row_collection`
  - `read_only_table`
  - `file_viewer`
  - `directory_viewer`
- [x] 集合编辑通过 row API 保存单行；前端按 `rowOperations` 判断新增、编辑、删除能力。
- [x] 禁用不可编辑资源的写入口。

Acceptance:

- 新 registry 资源能自动显示。
- `editable` flag 生效。
- 集合数据不会在前端一次性整表写回。

### Step 5: First SQL-backed resources

优先迁移低风险配置型数据，作为后续资源模板：

- [x] `whitelist_entries`
- [x] `persona`
- [x] `rp_profile`
- [x] `scenario_profile`
- [x] `global_profile_readiness`
- [x] `setup_state`

实现内容：

- 建表 table groups。
- 注册 resource definitions。
- 更新运行时调用链读取 SQLite。
- 删除对应旧文件读写路径。
- 添加 row-level tests。

Acceptance:

- runtime 只读写 SQLite。
- WebUI 可以查看和编辑这些资源。
- dump 覆盖稳定文件。
- stable dump 覆盖、确定性排序、路径安全和失败保留旧文件有测试。

### Step 6: Continue resource-by-resource migration

当前顺序已按实施中风险调整：

- [x] users
- [x] requests / approvals
- [x] scheduled jobs
- [x] global rules
- [x] toolset rules
- [x] user identities
- [x] group membership
- [ ] sessions metadata and messages
- [ ] scenario host per-session state
- [ ] assets indexes
- [ ] context read-only registry exposure

每迁移一组：

- 先定表组和 resource definition。
- 改 runtime repository。
- 改 WebUI 编辑能力。
- 加测试。
- 完成后拉起 5.5 medium 子 agent 做范围审查。

### Step 7: Verification

最终提交前至少执行：

```bash
npm run typecheck:all
npm run test
```

若涉及 WebUI 行为，执行：

```bash
npm run test:webui
```

## Review Protocol

每完成一个 step：

- Spawn 一个 `gpt-5.5` medium 子 agent。
- 审查输入包括本计划、当前 step 目标、已修改文件、关键测试结果。
- 子 agent 输出必须按严重程度列问题，不需要改代码。
- 主 agent 处理必须修复的问题；无法立即处理的记录到本计划或后续 backlog。

## Open Risks

- WebUI 自动 schema 表单若一次支持过多控件，容易变成新复杂源；第一版只支持文本、布尔、数字、枚举、数组/子表跳转。
- sessions/message schema 涉及现有会话页语义，迁移时必须同步检查 SSE/session display。
- `state_kv` fallback 需要严格限制，否则会退化成 JSON blob 数据库。
- `block_reset` 会让开发环境遇到 schema 变化时报错；本次接受该行为，必要时手动删除新 DB。
