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
  - 只描述 `rp_assistant` 模式下的真人化设定、关系基线与现实契约。
  - 当前字段收敛为：
    - `selfPositioning`
    - `socialRole`
    - `lifeContext`
    - `physicalPresence`
    - `bondToUser`
    - `closenessPattern`
    - `interactionPattern`
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

## Storage

- `users.json`
  - 存放 `user_profile` 字段与 `user_memories`。
- `global-rules.json`
  - 存放 `global_rules`。
- `toolset-rules.json`
  - 存放 `toolset_rules`。
- `persona.json`
  - 存放结构化 `persona` 字段。
- `rp-profile.json`
  - 存放结构化 `rpProfile` 字段。

显式迁移入口：

```bash
npm run migrate:memory -- data/data/<instance>
```

迁移会重写当前文件结构，并产出 `memory-migration-report.json`：

- `inventory`
  - 当前用户、用户记忆、全局规则、工具集规则数量
- `duplicates`
  - 迁移时合并掉的近重复条目
- `scopeFindings`
  - 明显写错类别、需要后续人工复核的条目

迁移覆盖的旧结构：

- `global-memories.json` -> `global-rules.json`
- `operation-notes.json` -> `toolset-rules.json`
- 旧用户字段 `sharedContext` -> `relationshipNote`
- 旧用户字段 `nickname` -> `preferredAddress`
- 旧 persona 字段会在迁移脚本里归并到新的结构化字段

## Prompt Injection Priority

注入顺序固定为：

1. `persona`
2. `rpProfile`（仅 `rp_assistant`）
3. `global_rules`
4. `toolset_rules`
5. `current_user_profile`
6. `current_user_memories`

规则：

- 高优先级内容只会压低优先级内容，不会反过来被低优先级内容抑制。
- `profileSummary` 会额外避开和显式 `user_memories` 重复的内容。
- `user_memories` 排序综合考虑：
  - `kind`
  - `importance`
  - `lastUsedAt`
  - `updatedAt`

Prompt 段标签语义：

- `persona`
  - bot 的名字、性格底色、说话方式和跨模式全局偏好
- `rpProfile`
  - RP 模式下的真人化设定、关系基线和现实契约
- `global_rules`
  - 默认工作流行为
- `toolset_rules`
  - 工具集或工作流局部规则
- `current_user_profile`
  - 当前触发用户的结构化卡片事实
- `current_user_memories`
  - 当前触发用户的长期偏好、边界和关系上下文

## Observability

当前已有的关键日志：

- `user_memory_upserted`
- `global_rule_upserted`
- `toolset_rule_upserted`
- `memory_scope_conflict_detected`
- `prompt_memory_items_suppressed`

这些日志用于定位：

- 为什么一次写入是创建还是更新已有条目
- 是否命中了近重复合并
- 是否触发了跨类别冲突警告
- 哪些低优先级条目在 prompt 注入阶段被抑制
