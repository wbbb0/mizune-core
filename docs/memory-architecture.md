# Memory Architecture

## Categories

- `persona`
  - 只描述 bot 在所有模式下都成立的全局人格底座。
  - 当前字段收敛为：
    - `name`
    - `temperament`
    - `speakingStyle`
    - `globalTraits`
    - `generalPreferences`
- `rpProfile`
  - 只描述 `rp_assistant` 模式下 bot 自身的真人化设定与现实契约。
  - 不保存面向某个用户的关系基线、亲密推进方式或互动偏好；这些信息应进入 `user_profile`、`user_memories` 或 `session` 范围上下文。
  - 当前字段收敛为：
    - `selfPositioning`
    - `socialRole`
    - `lifeContext`
    - `physicalPresence`
    - `realityContract`
    - `continuityFacts`
    - `hardLimits`
- `global_rules`
  - owner 级、跨任务长期生效的默认工作流规则。
- `toolset_rules`
  - 仅对特定工具集或工作流生效的局部长期规则。
- `user_profile`
  - 当前用户的结构化卡片资料。
  - 当前字段收敛为：
    - `preferredAddress`
    - `gender`
    - `residence`
    - `timezone`
    - `occupation`
    - `profileSummary`
    - `relationshipNote`
- `user_memories`
  - 当前用户的非结构化长期偏好、边界、习惯、关系背景与事实。
  - 运行时落到 `context_items`，由 `layer` 和 `subject_*` 字段区分是否固定注入、检索召回或待审。

## Context Memory Layers

`context_items` 是当前长期记忆的统一运行时底座。每条 item 同时保存：

- `scope`：旧调用链仍使用的范围字段。
- `subject_kind` / `subject_id`：明确归属主体；`user`、`session`、`toolset`、`mode` 必须有具体 ID，`global` 不需要 ID。
- `layer`：记忆进入 prompt 和维护流程的主要分类。

当前 layer 语义：

- `profile_slot`
  - 单槽位当前值，例如 `preferred_name`、`residence`、`timezone`、`occupation`、`communication_preference`、`relationship_note`、`session_purpose`。
  - 固定注入，写入同 slot 时会更新或 supersede 旧值。
- `core_fact`
  - 明确边界、高重要度事实、pin 住的事实或规则。
  - 固定注入，但受固定事实预算控制。
- `searchable_fact`
  - 稳定但不需要每轮都进 prompt 的长期事实。
  - 默认只走检索召回，避免固定记忆数量上限导致 prompt 撑爆。
- `episode`
  - 对话片段、摘要或原始事件的检索材料。
  - 不作为当前事实固定注入。
- `proposal`
  - 待审候选，不进入 prompt。
  - 低置信候选、global/toolset/mode 等当前不自动写入的范围会进入该层，并在 `manual_audit_events` 留审计事件。

## Write Path

- 模型不再通过 `scope` 选择 memory 类型。
- 写入入口改为显式工具名：
  - `patch_persona`
  - `upsert_global_rule`
  - `upsert_toolset_rule`
  - `patch_user_profile`
  - `upsert_user_memory`
- `user_memories`、`global_rules`、`toolset_rules` 都在 store 层做近重复检测。
- store 返回统一的写入诊断信息：
  - `action`
  - `finalAction`
  - `dedup.matchedBy`
  - `dedup.matchedExistingId`
  - `warning`
- 跨类别冲突检测也放在 store 层执行并记录日志，tool handler 只负责把结果透传给模型。
- `profileSummary` 在写入和 prompt 注入两侧都会压成单行短摘要，避免变成杂项记忆桶。
- 自动抽取器只输出候选；store 根据 slot、kind、importance、pin 和 scope 决定最终 layer。
- 低置信候选或当前不能自动写入的 scope 会写入 `proposal`，不会降级写成 user 记忆。

## Storage

- `state/state.sqlite`
  - `persona` 表存放结构化 `persona` 字段。
  - `rp_profile` 表存放结构化 `rpProfile` 字段。
  - `scenario_profile` 表存放结构化 `scenarioProfile` 字段。
  - `global_profile_readiness` 表存放 persona / RP / Scenario 全局资料准备度。
  - `setup_state` 表存放首次配置流程状态。
  - `users` 表存放用户资料字段。
  - `user_memories` 表存放旧版用户长期记忆条目；运行时不再从旧 `users.json` 导入或自动迁移这些数据。
  - `pending_requests` 表存放待处理好友请求与群请求。
  - `scheduled_jobs` 表存放定时任务定义与运行状态列，`scheduled_job_targets` 表存放任务目标会话。
  - `global_rules` 表存放全局规则。
  - `toolset_rules` 表存放工具集规则主体。
  - `toolset_rule_toolsets` 表存放工具集规则与工具集 ID 的一对多关系。
  - `user_identities` 表存放外部用户 ID 到内部用户 ID 的映射。
  - `group_membership_entries` 表存放群成员关系缓存。
  - `whitelist_entries` 表存放白名单条目。

## Prompt Injection Priority

注入顺序固定为：

1. `persona`
2. `rpProfile`（仅 `rp_assistant`）
3. `global_rules`
4. `toolset_rules`
5. `current_user_profile`
6. 固定 user facts：`profile_slot` 和 `core_fact`
7. 当前 session facts
8. 检索召回的 `searchable_fact` / `episode`

规则：

- 高优先级内容只会压低优先级内容，不会反过来被低优先级内容抑制。
- `profileSummary` 会额外避开和显式 `user_memories` 重复的内容。
- 固定 user facts 排序综合考虑：
  - `kind`
  - `importance`
  - 当前 query 相关性
  - `updatedAt`
- 语义检索只排除已经固定注入 prompt 的 itemId，不排除所有 user facts。
- `searchable_fact` 即使没有进入固定区，也仍可通过当前 query 召回。

Prompt 段标签语义：

- `persona`
  - bot 的名字、性格底色、说话方式和跨模式全局偏好
- `rpProfile`
  - RP 模式下 bot 自身的真人化设定和现实契约
- `global_rules`
  - 默认工作流行为
- `toolset_rules`
  - 工具集或工作流局部规则
- `current_user_profile`
  - 当前触发用户的结构化卡片事实
- `current_user_memories`
  - 当前触发用户固定注入的长期偏好、边界和关系上下文
- `retrieved_user_context`
  - 当前 query 召回的可复用长期事实或历史片段

## Maintenance

维护任务按 `context.retention.maintenanceIntervalMs` 周期运行：

- 摘要化和清理 user search chunks。
- 清理过期 session facts 和已删除 items。
- 按配置批量补齐 embedding / 重建内存索引。
- 审计长期不可达的 `searchable_fact`：
  - 如果超过 `context.retention.unreachableAuditAfterDays` 未进入 prompt、未被检索命中、且不是 pinned/core/profile 层，会标记 `audit_state=unreachable`。
  - `audit_state=unreachable` 的 searchable fact 会退出检索候选集，避免继续占用索引和召回预算。
  - 对应审计事件写入 `manual_audit_events`。
  - 后续人工更新或重新写入会清除旧 `audit_state`，让该记忆重新进入检索候选。

## Observability

当前已有的关键日志：

- `user_memory_upserted`
- `global_rule_upserted`
- `toolset_rule_upserted`
- `memory_scope_conflict_detected`
- `prompt_memory_items_suppressed`
- `context_memory_proposal_upserted`
- `context_memory_visibility_audited`
- `context_memory_visibility_audit_failed_open`

这些日志用于定位：

- 为什么一次写入是创建还是更新已有条目
- 是否命中了近重复合并
- 是否触发了跨类别冲突警告
- 哪些低优先级条目在 prompt 注入阶段被抑制
- 哪些候选进入了待审 proposal
- 哪些 searchable facts 长期不可达
