import test from "node:test";
import assert from "node:assert/strict";
import { buildPlannerQuestions } from "../../src/conversation/turnPlanner/definitions.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import {
  buildTurnPlannerFormatProbePrompt, buildTurnPlannerProbeInput,
  createDefaultTurnPlannerProbeCases, createDefaultTurnPlannerProbeToolsets,
  createTurnPlannerFormatProbeExecutor, evaluateTurnPlannerProbeSemantics,
  parseTurnPlannerProbeResponse, renderTurnPlannerProbeReport,
  runTurnPlannerFormatProbe, summarizeTurnPlannerProbeResults,
  type TurnPlannerProbeCase
} from "../../src/app/generation/turnPlannerFormatProbe.ts";

const config = createTestAppConfig();
const tools = createDefaultTurnPlannerProbeToolsets();
const cases = createDefaultTurnPlannerProbeCases();
const first = cases[0]!;
function response(probeCase: TurnPlannerProbeCase, overrides: Record<string, unknown> = {}): string {
  const output: Record<string, unknown> = { task_basis: "本轮需要查询并整理可见信息。" };
  for (const { question } of buildPlannerQuestions(buildTurnPlannerProbeInput(probeCase, tools))) {
    output[question.name] = question.type === "predicate" ? false : question.choices[0]!.value;
  }
  return JSON.stringify({ ...output, ...overrides });
}

test("探针使用生产JSON协议，任务依据在前且模型档位与回复分离", () => {
  const parsed = parseTurnPlannerProbeResponse(response(first, { model: "large", "toolset:web_research": true }), first, tools, config);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.data.replyDecision, "reply");
  assert.equal(parsed.data.modelTier, "large");
  assert.ok(parsed.data.taskBasis);
  assert.ok(parsed.data.toolsetIds.includes("web_research"));
  assert.equal(parseTurnPlannerProbeResponse("reason: 旧协议\nreply_decision: reply_small", first, tools, config).ok, false);
  const value = JSON.parse(response(first));
  const { task_basis, ...rest } = value;
  assert.equal(parseTurnPlannerProbeResponse(JSON.stringify({ ...rest, task_basis }), first, tools, config).ok, false);
});

test("探针复用生产等待校验，完整问题不能被模型短路为等待", () => {
  const parsed = parseTurnPlannerProbeResponse(response(first, { reply: "wait" }), first, tools, config);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.rawData.replyDecision, "wait");
  assert.equal(parsed.data.replyDecision, "reply");
  assert.ok(parsed.data.normalizationWarnings.includes("reply_decision_normalized"));
});

test("探针复用实际结构化上下文激活，不依赖模型自报标签", () => {
  const structured = cases.find(item => item.id === "structured-context")!;
  const parsed = parseTurnPlannerProbeResponse(response(structured), structured, tools, config);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.ok(parsed.data.toolsetIds.includes("chat_context"));
});

test("默认样例有明确档位边界，不再接受大小模型任一结果", () => {
  for (const item of cases.filter(item => item.id !== "unfinished-wait")) assert.equal(item.expectations?.expectedModelTiers?.length, 1, item.id);
  assert.deepEqual(cases.find(item => item.id === "shell-debug")?.expectations?.expectedModelTiers, ["large"]);
  assert.deepEqual(cases.find(item => item.id === "time-question")?.expectations?.expectedModelTiers, ["small"]);
});

test("语义判定失败会使摘要及CLI验收失败，并保留原始响应", async () => {
  const wrong = response(first, { model: "large", "toolset:web_research": true });
  const result = await runTurnPlannerFormatProbe({ config, modelRef: ["test"], availableToolsets: tools, cases: [first], executePrompt: async () => wrong });
  assert.equal(result.results[0]?.rawText, wrong);
  assert.equal(result.summary.failedCases, 1);
  assert.ok(result.results[0]?.semantic?.issues.includes("unexpected_model:large"));
  assert.match(renderTurnPlannerProbeReport(result), /semantic=mismatch/);
  assert.deepEqual(summarizeTurnPlannerProbeResults(result.results), result.summary);
});

test("明确需要的工具漏选会被记录为语义错误", () => {
  const parsed = parseTurnPlannerProbeResponse(response(first), first, tools, config);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.ok(evaluateTurnPlannerProbeSemantics(first, parsed.data).issues.includes("missing_required_toolset:web_research"));
});

test("探针使用自动生成提示词并关闭思考，不额外执行任何业务工具", async () => {
  let captured: Record<string, unknown> | undefined;
  const executor = createTurnPlannerFormatProbeExecutor({ config, client: { supportsStructuredOutput: () => true, generate: async input => {
    captured = input as unknown as Record<string, unknown>;
    return { text: "{}", finishReason: { kind: "completed" as const }, reasoningContent: "", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: null, reasoningTokens: 0, providerReported: false, requestCount: 1, modelRef: "test", model: "test" } };
  } }, timeoutMs: 1000 });
  const promptMessages = buildTurnPlannerFormatProbePrompt(first, tools);
  await executor({ modelRef: ["main"], probeCase: first, availableToolsets: tools, promptMessages });
  assert.equal(captured?.enableThinkingOverride, false);
  assert.equal(captured?.skipDebugDump, true);
  assert.equal(captured?.tools, undefined);
  assert.ok(captured?.responseFormat);
  assert.ok(Number(captured?.maxOutputTokensOverride) >= 512);
  assert.match(String(promptMessages[0]?.content), /task_basis/);
});


test("默认半句样例能通过生产等待条件，不构造永远无法满足的预期", () => {
  const item = cases.find(value => value.id === "unfinished-wait")!;
  const parsed = parseTurnPlannerProbeResponse(response(item, { reply: "wait" }), item, tools, config);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(evaluateTurnPlannerProbeSemantics(item, parsed.data).ok, true);
});
