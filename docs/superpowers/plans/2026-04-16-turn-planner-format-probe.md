# Turn Planner Format Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reusable real-API probe for turn-planner output formats, with a CLI script that runs representative cases against a chosen model ref and reports parse stability.

**Architecture:** Keep the reusable logic in a focused `src/` module that builds probe cases, validates the raw planner response format, and produces a summary. Keep `scripts/turn-planner-format-probe.ts` as a thin CLI wrapper that loads config, creates an `LlmClient`, invokes the reusable probe runner, and prints a readable report.

**Tech Stack:** TypeScript, `tsx`, existing `loadConfig`, `LlmClient`, `buildTurnPlannerPrompt`, `pino`.

---

### Task 1: Define reusable probe contracts and parsing behavior

**Files:**
- Create: `src/app/generation/turnPlannerFormatProbe.ts`
- Test: `test/generation/turn-planner-format-probe.test.tsx`

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import {
  parseTurnPlannerProbeResponse,
  summarizeTurnPlannerProbeResults
} from "../../src/app/generation/turnPlannerFormatProbe.ts";

await runCase("parseTurnPlannerProbeResponse extracts fixed-format fields", async () => {
  const parsed = parseTurnPlannerProbeResponse([
    "reason: 需要查外部信息",
    "reply_decision: reply_small",
    "topic_decision: continue_topic",
    "required_capabilities: external_info_lookup, web_navigation",
    "context_dependencies: none",
    "recent_domain_reuse: web_research",
    "followup_mode: elliptical",
    "toolset_ids: web_research"
  ].join("\n"));

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.data?.requiredCapabilities, ["external_info_lookup", "web_navigation"]);
  assert.equal(parsed.data?.toolsetIds[0], "web_research");
});

await runCase("summarizeTurnPlannerProbeResults counts format failures", async () => {
  const summary = summarizeTurnPlannerProbeResults([
    {
      caseId: "ok-case",
      rawText: "reason: ok",
      parse: {
        ok: true,
        data: {
          reason: "ok",
          replyDecision: "reply_small",
          topicDecision: "continue_topic",
          requiredCapabilities: [],
          contextDependencies: [],
          recentDomainReuse: [],
          followupMode: "none",
          toolsetIds: []
        }
      }
    },
    {
      caseId: "bad-case",
      rawText: "garbled",
      parse: {
        ok: false,
        error: "missing reason"
      }
    }
  ]);

  assert.equal(summary.totalCases, 2);
  assert.equal(summary.okCases, 1);
  assert.equal(summary.failedCases, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx test/generation/turn-planner-format-probe.test.tsx`
Expected: FAIL because `turnPlannerFormatProbe.ts` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

```ts
export function parseTurnPlannerProbeResponse(rawText: string) {
  // Parse fixed `key: value` lines into a structured object and surface a clear parse error.
}

export function summarizeTurnPlannerProbeResults(results: TurnPlannerProbeCaseResult[]) {
  // Count ok/failed cases and collect failure ids.
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx test/generation/turn-planner-format-probe.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/generation/turn-planner-format-probe.test.tsx src/app/generation/turnPlannerFormatProbe.ts
git commit -m "feat: add turn planner probe parsing helpers"
```

### Task 2: Add probe case runner with injected LLM execution

**Files:**
- Modify: `src/app/generation/turnPlannerFormatProbe.ts`
- Modify: `test/generation/turn-planner-format-probe.test.tsx`

- [ ] **Step 1: Write the failing test**

```ts
await runCase("runTurnPlannerFormatProbe preserves per-case raw output and parse status", async () => {
  const result = await runTurnPlannerFormatProbe({
    modelRef: ["lms_qwen35_a3b"],
    availableToolsets: [createProbeToolset("web_research")],
    cases: [createProbeCase({ id: "web-followup", batchText: "继续，点进去看看" })],
    executePrompt: async () => [
      "reason: 延续网页操作",
      "reply_decision: reply_small",
      "topic_decision: continue_topic",
      "required_capabilities: web_navigation",
      "context_dependencies: prior_web_context",
      "recent_domain_reuse: web_research",
      "followup_mode: elliptical",
      "toolset_ids: web_research"
    ].join("\n")
  });

  assert.equal(result.results[0]?.caseId, "web-followup");
  assert.equal(result.results[0]?.parse.ok, true);
  assert.equal(result.summary.okCases, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx test/generation/turn-planner-format-probe.test.tsx`
Expected: FAIL because `runTurnPlannerFormatProbe` is missing.

- [ ] **Step 3: Write minimal implementation**

```ts
export async function runTurnPlannerFormatProbe(input: TurnPlannerFormatProbeInput) {
  const results = [];
  for (const probeCase of input.cases) {
    const rawText = await input.executePrompt(...);
    results.push({
      caseId: probeCase.id,
      rawText,
      parse: parseTurnPlannerProbeResponse(rawText)
    });
  }
  return {
    results,
    summary: summarizeTurnPlannerProbeResults(results)
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx test/generation/turn-planner-format-probe.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/generation/turn-planner-format-probe.test.tsx src/app/generation/turnPlannerFormatProbe.ts
git commit -m "feat: add reusable turn planner probe runner"
```

### Task 3: Add the real CLI wrapper

**Files:**
- Create: `scripts/turn-planner-format-probe.ts`
- Modify: `src/app/generation/turnPlannerFormatProbe.ts`
- Test: `test/generation/turn-planner-format-probe.test.tsx`

- [ ] **Step 1: Write the failing test**

```ts
await runCase("renderTurnPlannerProbeReport prints summary and failed cases", async () => {
  const report = renderTurnPlannerProbeReport({
    modelRef: ["lms_qwen35_a3b"],
    summary: {
      totalCases: 2,
      okCases: 1,
      failedCases: 1,
      failedCaseIds: ["bad-case"]
    },
    results: [...]
  });

  assert.match(report, /lms_qwen35_a3b/);
  assert.match(report, /failed=1/);
  assert.match(report, /bad-case/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx test/generation/turn-planner-format-probe.test.tsx`
Expected: FAIL because `renderTurnPlannerProbeReport` is missing.

- [ ] **Step 3: Write minimal implementation**

```ts
export function renderTurnPlannerProbeReport(result: TurnPlannerFormatProbeRunResult): string {
  // Return a readable multiline report for CLI output.
}

// scripts/turn-planner-format-probe.ts
const config = loadConfig(process.env);
const client = new LlmClient(config, pino({ level: "info" }));
const result = await runTurnPlannerFormatProbe({
  modelRef: [selectedModelRef],
  ...createDefaultTurnPlannerProbeInput(config, client)
});
console.log(renderTurnPlannerProbeReport(result));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx test/generation/turn-planner-format-probe.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/generation/turn-planner-format-probe.test.tsx src/app/generation/turnPlannerFormatProbe.ts scripts/turn-planner-format-probe.ts
git commit -m "feat: add turn planner format probe cli"
```

### Task 4: Verify with focused checks

**Files:**
- Modify: none

- [ ] **Step 1: Run focused probe tests**

Run: `npx tsx test/generation/turn-planner-format-probe.test.tsx`
Expected: PASS

- [ ] **Step 2: Run bot typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Smoke-run the CLI help path**

Run: `npx tsx scripts/turn-planner-format-probe.ts --help`
Expected: exits successfully and prints available flags without making a model request

- [ ] **Step 4: Commit verification-only updates if needed**

```bash
git add docs/superpowers/plans/2026-04-16-turn-planner-format-probe.md
git commit -m "docs: add turn planner format probe plan"
```
