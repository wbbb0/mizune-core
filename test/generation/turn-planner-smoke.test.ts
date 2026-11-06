import test from "node:test";
import assert from "node:assert/strict";
import { buildPlannerQuestions } from "../../src/conversation/turnPlanner/definitions.ts";
import {
  parsePlannerSmokeOptions, plannerSmokeCases, buildPlannerSmokeInput, buildPlannerSmokeChatRequest,
  parsePlannerSmokeChatOutput, scorePlannerSmokeResult, summarizePlannerSmokeResults
} from "../../smoke/llm/turn-planner-smoke-support.ts";

test("planner smoke defaults to bounded synthetic cases and requires explicit comparison", () => {
  const defaults = parsePlannerSmokeOptions([]);
  assert.deepEqual(defaults.modes, ["task_basis"]);
  assert.equal(defaults.repeat, 1);
  assert.equal(defaults.selectedCases.length, 8);
  assert.deepEqual(parsePlannerSmokeOptions(["--compare"]).modes, ["task_basis", "direct", "short_basis"]);
  const selected = parsePlannerSmokeOptions(["--backend", "decision", "--instance", "test", "--model-ref", "provider/model", "--case", "host-shell,public-query", "--timeout-ms", "5000"]);
  assert.equal(selected.backend, "decision");
  assert.equal(selected.timeoutMs, 5000);
  assert.deepEqual(selected.selectedCases.map(item => item.id), ["public-query", "host-shell"]);
  for (const argv of [["--backend", "other"], ["--backend", "decision", "--compare"], ["--compare", "--mode", "direct"], ["--repeat", "0"], ["--repeat", "21"], ["--case", "missing"], ["--timeout-ms", "NaN"], ["--unexpected"]]) {
    assert.throws(() => parsePlannerSmokeOptions(argv));
  }
});

test("smoke control modes reuse production question conditions and only alter basis output", () => {
  const input = buildPlannerSmokeInput(plannerSmokeCases[0]!);
  const questions = buildPlannerQuestions(input);
  for (const mode of ["task_basis", "direct", "short_basis"] as const) {
    const request = buildPlannerSmokeChatRequest(input, mode);
    const system = String(request.messages[0]?.content);
    for (const definition of questions) {
      assert.ok(system.includes(String(definition.question.instructions)));
      if (definition.question.type === "choice") for (const option of definition.question.choices) assert.ok(system.includes(option.description!));
    }
    assert.equal(request.responseFormat.type, "json_schema");
    if (request.responseFormat.type !== "json_schema") continue;
    const schema = request.responseFormat.schema as { required: string[]; properties: Record<string, { maxLength?: number }> };
    assert.equal(schema.required.includes("task_basis"), mode !== "direct");
    if (mode === "short_basis") assert.equal(schema.properties.task_basis?.maxLength, 12);
  }
});

test("evaluation-only direct protocol never expands production accepted output", () => {
  const input = buildPlannerSmokeInput(plannerSmokeCases[0]!);
  assert.equal(parsePlannerSmokeChatOutput('{"model":"small"}', input, "task_basis"), null);
  assert.equal(parsePlannerSmokeChatOutput('{"model":"small"}', input, "direct")?.modelTier, "small");
  assert.equal(parsePlannerSmokeChatOutput('{"task_basis":"公开资料查询","model":"small"}', input, "short_basis")?.modelTier, "small");
  assert.equal(parsePlannerSmokeChatOutput('{"task_basis":"字字字字字字字字字字字字字","model":"small"}', input, "short_basis"), null);
  assert.equal(parsePlannerSmokeChatOutput('{"model":"unknown"}', input, "direct"), null);
  assert.equal(parsePlannerSmokeChatOutput('{"model":"small","extra":true}', input, "direct"), null);
  assert.equal(parsePlannerSmokeChatOutput('{"model":"large","model":"small"}', input, "direct"), null);
});

test("smoke scoring counts wrong tiers and undetermined answers without inventing usage", () => {
  const small = plannerSmokeCases.find(item => item.expectedTier === "small")!;
  const large = plannerSmokeCases.find(item => item.expectedTier === "large")!;
  const input = buildPlannerSmokeInput(small);
  const plan = parsePlannerSmokeChatOutput('{"model":"small"}', input, "direct")!;
  const base = { backend: "chat" as const, mode: "direct" as const, iteration: 1, modelRef: "test/model", elapsedMs: 10 };
  const correct = scorePlannerSmokeResult({ ...base, item: small, plan });
  const missed = scorePlannerSmokeResult({ ...base, item: large, plan, elapsedMs: 20 });
  const extra = scorePlannerSmokeResult({ ...base, item: small, plan: { ...plan, modelTier: "large" }, elapsedMs: 30 });
  const refused = scorePlannerSmokeResult({ ...base, item: large, plan: { ...plan, modelSelectionStatus: "undetermined", undeterminedQuestions: ["model"] }, elapsedMs: 40 });
  const invalid = scorePlannerSmokeResult({ ...base, item: large, plan: null, elapsedMs: 50 });
  assert.equal(refused.passed, false);
  assert.equal(refused.actualTier, null);
  const summary = summarizePlannerSmokeResults([correct, missed, extra, refused, invalid]);
  assert.equal(summary.correct, 1);
  assert.equal(summary.accuracy, 0.2);
  assert.equal(summary.parsed, 4);
  assert.equal(summary.missedUpgrades, 1);
  assert.equal(summary.extraUpgrades, 1);
  assert.equal(summary.undetermined, 1);
  assert.equal(summary.p95Ms, 50);
  assert.equal(summary.inputTokens, null);
  assert.equal(summary.outputTokens, null);
  assert.equal(summary.cachedTokens, null);
});
