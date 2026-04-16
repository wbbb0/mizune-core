# Memory Trace Review

Date: 2026-04-16

This note records the local trace and log review used to close the memory refactor hardening checklist.

## Scope reviewed

- Memory write diagnostics for:
  - `user_memories`
  - `global_rules`
  - `toolset_rules`
- Prompt-side suppression logging for lower-priority memory items
- Migration dry-run findings for duplicate and cross-category drift
- Repository-wide cleanup of legacy generic memory tool names

## Validation sources

- `npm run typecheck:all`
- `npm run test:bot`
- `npx tsx --eval 'import { mkdtemp, rm, writeFile } from "node:fs/promises"; import { tmpdir } from "node:os"; import { join } from "node:path"; import { migrateMemoryDataDir } from "./src/memory/migration.ts"; (async () => { const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-memory-review-")); try { await writeFile(join(dataDir, "users.json"), JSON.stringify([{ userId: "10001", nickname: "老王", sharedContext: "现实朋友", profileSummary: "做事很快。\\n经常先给结论。喜欢把问题拆开处理。", memories: [{ id: "mem_1", title: "称呼", content: "希望你叫我老王", updatedAt: 1 }, { id: "mem_2", title: "用户称呼偏好", content: "希望你叫我老王", updatedAt: 2 }, { id: "mem_3", title: "交流边界", content: "不要替我做决定", updatedAt: 3 }], createdAt: 1 }], null, 2)); await writeFile(join(dataDir, "persona.json"), JSON.stringify({ identity: "可靠搭档", speakingStyle: "直接一点", roleplayRequirements: "保持角色一致。", outputFormatRequirements: "默认先给结论再展开。", memories: [{ id: "pm_1", title: "输出习惯", content: "所有任务默认先给结论再展开。", updatedAt: 4 }] }, null, 2)); await writeFile(join(dataDir, "global-memories.json"), JSON.stringify([{ id: "gr_1", title: "输出顺序", content: "先给结论再展开。", updatedAt: 5 }, { id: "gr_2", title: "默认输出顺序", content: "默认先给结论再展开。", updatedAt: 6 }], null, 2)); await writeFile(join(dataDir, "operation-notes.json"), JSON.stringify([{ id: "tr_1", title: "网页登录处理", content: "只有遇到网页登录任务时才读取站点凭据。", toolsetIds: ["web_research"], source: "owner", updatedAt: 7 }, { id: "tr_2", title: "网页登录规则", content: "只有遇到网页登录任务时才读取站点凭据。", toolsetIds: ["web_research"], source: "owner", updatedAt: 8 }], null, 2)); const report = await migrateMemoryDataDir({ dataDir }); console.log(JSON.stringify({ duplicateCount: report.duplicates.length, scopeFindingCount: report.scopeFindings.length, findings: report.scopeFindings }, null, 2)); } finally { await rm(dataDir, { recursive: true, force: true }); } })().catch((error) => { console.error(error); process.exit(1); });'`
- Repository grep over legacy generic memory tool names and operation-note terminology

## Reviewed results

- Store write logs now include:
  - `targetCategory`
  - `finalAction`
  - `dedupMatchedBy`
  - `dedupMatchedExistingId`
  - `dedupSimilarityScore`
  - `rerouteResult`
  - `rerouteSuggestedScope`
  - `rerouteReason`
- Tool-facing write results now expose:
  - `dedup.similarityScore`
  - `reroute.result`
  - `reroute.suggestedScope`
  - `reroute.reason`
- Prompt-side `profileSummary` rendering now removes only the clauses that duplicate explicit user memories, instead of suppressing the whole summary or hiding the memory row.
- Prompt suppression logging remains covered by `prompt_memory_items_suppressed` in `test/generation/generation-prompt-builder.test.tsx`.

## Migration dry-run findings

The dry-run audit command produced:

```json
{
  "duplicateCount": 4,
  "scopeFindingCount": 4,
  "findings": [
    {
      "category": "persona",
      "title": "默认输出要求",
      "suggestedScope": "global_rules",
      "reason": "旧 persona 输出格式要求更像跨任务工作流规则，已提升为 global_rules。"
    },
    {
      "category": "persona",
      "title": "输出习惯",
      "suggestedScope": "global_rules",
      "reason": "内容更像跨任务长期工作流规则，不像 bot 身份、人设、口吻或角色边界。 迁移时已提升为 global_rules。"
    },
    {
      "category": "user_memories",
      "title": "称呼",
      "suggestedScope": "user_profile",
      "reason": "内容更像结构化用户卡片字段，适合写入 user profile。"
    },
    {
      "category": "user_memories",
      "title": "用户称呼偏好",
      "suggestedScope": "user_profile",
      "reason": "内容更像结构化用户卡片字段，适合写入 user profile。"
    }
  ]
}
```

Interpretation:

- Duplicate collapse is active for user memories, global rules, and toolset rules.
- The dominant remaining drift pattern in the migration sample is still profile-like user memory content, which is now surfaced explicitly as `user_profile` suggestions instead of being silently accepted.
- Persona-to-global workflow drift is also surfaced explicitly and promoted during migration.

## Cleanup review

The repository-wide grep found no remaining legacy generic memory tool names in `README.md`, `docs/`, or `src/`.

The only remaining hits are negative assertions in tests that verify the old polymorphic API surface is gone.
