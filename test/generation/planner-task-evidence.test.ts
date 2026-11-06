import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { projectPlannerTaskEvidence } from "../../src/app/generation/plannerTaskEvidence.ts";
import { planGenerationModel } from "../../src/app/generation/generationModelPlanner.ts";
import { handleGenerationTurnPlanner } from "../../src/app/generation/generationTurnPlanner.ts";
import { buildPlannerQuestions } from "../../src/conversation/turnPlanner/definitions.ts";
import type { TurnPlannerInput } from "../../src/conversation/turnPlanner/types.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { createGenerationReplyGateDeps, createGenerationReplyGateHandlers, createGenerationReplyGateInput, createReplyGateBatchMessage } from "../helpers/reply-gate-fixtures.tsx";
const taskContext = { primary: { taskId: "primary-id", status: "active" as const, objective: "原始主任务目标", next: "原始下一步", blocker: "原始障碍" }, parked: [{ taskId: "parked-id", status: "suspended" as const, objective: "原始停放目标", summary: "原始停放摘要" }] };
const taskSummary = "原始历史摘要";

for (const modeOnly of [false, true]) test(`shared task evidence projects natural language and preserves targets in ${modeOnly ? "model-only" : "full"} planning`, async () => {
  const config = createTestAppConfig({ llm: { enabled: true, turnPlanner: { enabled: true } } });
  config.llm.models.large = { ...config.llm.models.main!, model: "large" };
  config.llm.routingPresets.test!.mainLarge = ["large"];
  const original = structuredClone(taskContext);
  const safetyInputs: any[] = [];
  let plannerInput: TurnPlannerInput | undefined;
  const contentSafetyService = { async projectPromptMessages(input: any) {
    safetyInputs.push(input);
    return { ...input, recentMessages: input.recentMessages.map((message: any) => ({ ...message, content: `已过滤:${message.content}` })), batchMessages: input.batchMessages.map((message: any) => ({ ...message, text: `已过滤:${message.text}` })) };
  } };
  const deps = createGenerationReplyGateDeps({ config, logger: pino({ level: "silent" }),
    llmClient: { isConfigured() { return true; } } as any, contentSafetyService: contentSafetyService as any,
    turnPlanner: { isEnabled() { return true; }, async decide(input: TurnPlannerInput) {
      plannerInput = input;
      return { replyDecision: "reply", modelTier: "large", modelSelectionStatus: "decided", reason: "完整模型", topicDecision: "continue_topic", requiredCapabilities: [], contextDependencies: [], recentDomainReuse: [], followupMode: "none", toolsetIds: [] };
    } } as any });
  if (modeOnly) await planGenerationModel(deps, { entryPoint: "internal_trigger", sessionId: "test", chatType: "private", relationship: "owner", recentMessages: [{ role: "user", content: "原始历史正文" }], batchMessages: [createReplyGateBatchMessage({ text: "原始触发指令" })], availableToolsets: [], taskContext, taskSummary });
  else {
    const initial = createGenerationReplyGateInput();
    await handleGenerationTurnPlanner(deps, createGenerationReplyGateHandlers(), { ...initial, taskContext, taskSummary,
      historyForPrompt: [{ role: "user", content: "此前已过滤历史正文" }],
      batchMessages: [{ ...initial.batchMessages[0]!, audioSources: [], text: "此前已过滤当前消息" }] });
  }
  assert.equal(safetyInputs.length, 1);
  const projected = plannerInput!;
  assert.equal(projected.taskSummary, `已过滤:${taskSummary}`);
  assert.deepEqual(projected.taskContext, {
    primary: { taskId: "primary-id", status: "active", objective: "已过滤:原始主任务目标", next: "已过滤:原始下一步", blocker: "已过滤:原始障碍" },
    parked: [{ taskId: "parked-id", status: "suspended", objective: "已过滤:原始停放目标", summary: "已过滤:原始停放摘要" }]
  });
  assert.deepEqual(taskContext, original);
  assert.equal(taskSummary, "原始历史摘要");
  assert.doesNotMatch(JSON.stringify(safetyInputs), /primary-id|parked-id|suspended/);
  if (modeOnly) {
    assert.equal(projected.recentMessages[0]!.content, "已过滤:原始历史正文");
    assert.equal(projected.batchMessages[0]!.text, "已过滤:原始触发指令");
    assert.equal(projected.requirements.taskIntent, false);
  } else {
    assert.equal(projected.recentMessages[0]!.content, "此前已过滤历史正文");
    assert.equal(projected.batchMessages[0]!.text, "此前已过滤当前消息");
    assert.equal(safetyInputs[0].batchMessages.length, 0);
    assert.equal(projected.requirements.taskIntent, true);
    const task = buildPlannerQuestions(projected).find(({ question }) => question.name === "task")!.question;
    if (task.type !== "choice") throw new Error("expected task choice");
    assert.ok(task.choices.some(choice => choice.value === "restore_parked:parked-id" && choice.description?.includes("已过滤:原始停放目标")));
  }
});

test("malformed task evidence projection fails without returning unfiltered input", async () => {
  const service = { async projectPromptMessages(input: any) { return { ...input, recentMessages: [] }; } };
  await assert.rejects(projectPlannerTaskEvidence(service as any, { sessionId: "test", source: "test", taskContext, taskSummary }), /投影结构无效/);
  assert.equal(taskContext.primary.objective, "原始主任务目标");
});
