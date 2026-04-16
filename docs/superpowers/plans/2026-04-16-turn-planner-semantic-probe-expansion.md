# Turn Planner Semantic Probe Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the turn-planner probe from format validation into semantic evaluation with richer built-in cases, deterministic correction of obvious semantic mistakes, and reports that show raw versus normalized decisions.

**Architecture:** Keep the CLI wrapper thin. Concentrate the new work in `turnPlannerFormatProbe.ts`: enrich probe case metadata with semantic expectations, parse raw decisions separately from normalized decisions, add a small deterministic semantic normalization layer for clearly wrong combinations, and report both evaluation outcomes and warnings.

**Tech Stack:** TypeScript, `tsx`, existing probe script, `LlmClient`, current turn-planner prompt builder.

---

### Task 1: Lock semantic expectations and raw-vs-normalized reporting with tests

**Files:**
- Modify: `test/generation/turn-planner-format-probe.test.tsx`
- Modify: `src/app/generation/turnPlannerFormatProbe.ts`

- [ ] **Step 1: Write the failing tests**

Add tests that require:
- expanded default cases to include more semantic slices
- parse results to preserve both raw and normalized decisions
- report output to show semantic expectation match / mismatch

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx test/generation/turn-planner-format-probe.test.tsx`
Expected: FAIL because current probe does not expose raw decisions or semantic evaluation.

- [ ] **Step 3: Write minimal implementation**

Implement:
- probe case expectation metadata
- raw decision alongside normalized decision
- semantic evaluation result structure

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx test/generation/turn-planner-format-probe.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/generation/turn-planner-format-probe.test.tsx src/app/generation/turnPlannerFormatProbe.ts
git commit -m "feat: add semantic expectations to turn planner probe"
```

### Task 2: Add deterministic semantic corrections for obvious mistakes

**Files:**
- Modify: `src/app/generation/turnPlannerFormatProbe.ts`
- Modify: `test/generation/turn-planner-format-probe.test.tsx`

- [ ] **Step 1: Write the failing tests**

Add tests that require deterministic corrections for:
- `wait + new_topic -> continue_topic`
- structured context capabilities / dependencies implying `chat_context`
- `web_research + local_file_access` implying `local_file_io`
- `shell_execution` implying `shell_runtime`

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx test/generation/turn-planner-format-probe.test.tsx`
Expected: FAIL because current normalization only handles the wait/topic rule.

- [ ] **Step 3: Write minimal implementation**

Implement a narrowly-scoped semantic normalization layer and warnings for each automatic correction.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx test/generation/turn-planner-format-probe.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/generation/turn-planner-format-probe.test.tsx src/app/generation/turnPlannerFormatProbe.ts
git commit -m "feat: normalize obvious turn planner semantic mistakes"
```

### Task 3: Expand built-in probe cases and report output

**Files:**
- Modify: `src/app/generation/turnPlannerFormatProbe.ts`
- Modify: `scripts/turn-planner-format-probe.ts`
- Modify: `test/generation/turn-planner-format-probe.test.tsx`

- [ ] **Step 1: Write the failing tests**

Add tests that require:
- built-in cases expanded into a broader semantic set
- report output to include semantic pass/fail and raw-vs-normalized differences

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx test/generation/turn-planner-format-probe.test.tsx`
Expected: FAIL because current case set and report are still format-centric.

- [ ] **Step 3: Write minimal implementation**

Implement:
- 12-16 built-in cases spanning wait boundaries, structured context, web/file linkage, shell/file linkage, conversation navigation, and delegation
- report lines showing semantic status and normalized-vs-raw differences where relevant

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx test/generation/turn-planner-format-probe.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/generation/turn-planner-format-probe.test.tsx src/app/generation/turnPlannerFormatProbe.ts scripts/turn-planner-format-probe.ts
git commit -m "feat: expand turn planner semantic probe coverage"
```

### Task 4: Verify on the real `lms_qwen35_a3b` model

**Files:**
- Modify: none

- [ ] **Step 1: Run focused tests**

Run: `npx tsx test/generation/turn-planner-format-probe.test.tsx`
Expected: PASS

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Run the real semantic probe**

Run: `CONFIG_INSTANCE=dev npx tsx scripts/turn-planner-format-probe.ts --model-ref lms_qwen35_a3b --timeout-ms 20000`
Expected: probe completes and report shows format pass/fail, semantic pass/fail, raw-vs-normalized differences, and warnings.

- [ ] **Step 4: Commit verification updates if needed**

```bash
git add docs/superpowers/plans/2026-04-16-turn-planner-semantic-probe-expansion.md
git commit -m "docs: add turn planner semantic probe expansion plan"
```
