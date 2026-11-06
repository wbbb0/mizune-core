import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { planGenerationModel } from "../../src/app/generation/generationModelPlanner.ts";
import type { TurnPlannerInput, TurnPlannerResult } from "../../src/conversation/turnPlanner/types.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { createReplyGateBatchMessage } from "../helpers/reply-gate-fixtures.tsx";
const logger = pino({ level: "silent" });
const largePlan: TurnPlannerResult = { replyDecision: "reply", modelTier: "large", modelSelectionStatus: "decided", taskBasis: "需要综合已有材料，满足多个相互约束的要求。", reason: "使用完整模型", topicDecision: "continue_topic", toolsetIds: [], requiredCapabilities: [], contextDependencies: [], recentDomainReuse: [], followupMode: "none" };
function fixture(options: { enabled?: boolean; equivalent?: boolean; largeAvailable?: boolean; answer?: TurnPlannerResult } = {}) {
  const config = createTestAppConfig({ llm: { enabled: true, turnPlanner: { enabled: options.enabled ?? true } } });
  if (!options.equivalent) {
    config.llm.models.large = { ...config.llm.models.main!, model: "test-large" };
    config.llm.routingPresets.test!.mainLarge = ["large"];
  }
  const calls: TurnPlannerInput[] = [];
  const records: any[] = [];
  const persisted: string[] = [];
  const deps = { config, logger, llmClient: { isConfigured(refs: string[]) { return !(options.largeAvailable === false && refs.includes("large")); } }, turnPlanner: { isEnabled() { return true; }, async decide(input: TurnPlannerInput) { calls.push(input); return options.answer ?? largePlan; } }, sessionManager: { appendInternalTranscript(_id: string, value: unknown) { records.push(value); } }, persistSession(_id: string, reason: string) { persisted.push(reason); } };
  return { deps, calls, records, persisted };
}
const input = { entryPoint: "continuation" as const, sessionId: "entry-test", chatType: "private" as const, relationship: "owner" as const,
  recentMessages: [], availableToolsets: [], batchMessages: [createReplyGateBatchMessage({ text: "继续" })],
  taskContext: { primary: { taskId: "task-1", status: "active" as const, objective: "比较多套方案并验证约束的一致性" }, parked: [] }, taskSummary: "此前已确认需要复杂方案比较与一致性分析。" };

test("model-only planning preserves task context while requesting no reply/topic/task/tool actions", async () => {
  const { deps, calls, records } = fixture();
  const result = await planGenerationModel(deps as any, input);
  assert.deepEqual(result.resolvedModelRef, ["large"]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.requirements, { modelSelection: true, replyGate: false, semanticWait: false, topicSwitch: false, taskIntent: false, toolSelection: false, skillSelection: false });
  assert.equal(calls[0]!.taskContext?.primary?.objective, input.taskContext.primary.objective);
  assert.equal(calls[0]!.taskSummary, input.taskSummary);
  assert.equal(records[0].taskBasis, largePlan.taskBasis);
  assert.deepEqual(records[0].plannerReasons, ["modelSelection"]);
  assert.equal(records[0].action, "continue");
});

for (const options of [{ enabled: false }, { equivalent: true }]) test(`disabled/equivalent routes avoid planning and recording: ${JSON.stringify(options)}`, async () => {
  const { deps, calls, records } = fixture(options);
  assert.deepEqual((await planGenerationModel(deps as any, input)).resolvedModelRef, ["main"]);
  assert.equal(calls.length, 0);
  assert.equal(records.length, 0);
});

for (const available of [true, false]) test(`undetermined selection retains the large route without silently downgrading: ${available}`, async () => {
  const { deps, records } = fixture({ largeAvailable: available, answer: { ...largePlan, modelTier: undefined, modelSelectionStatus: "undetermined" } as any });
  const result = await planGenerationModel(deps as any, input);
  assert.deepEqual(result.resolvedModelRef, ["large"]);
  assert.equal(records[0].modelSelectionStatus, "undetermined");
  assert.equal(records[0].modelTier, undefined);
});

test("model-only entry ignores unsolicited wait, topic and task actions", async () => {
  const { deps, records } = fixture({ answer: { ...largePlan, replyDecision: "wait", topicDecision: "new_topic", taskIntent: { kind: "cancel_current", confidence: "high" } } });
  const result = await planGenerationModel(deps as any, input);
  assert.equal(result.plannerDecision?.replyDecision, "reply");
  assert.equal(result.plannerDecision?.topicDecision, "continue_topic");
  assert.equal(result.plannerDecision?.taskIntent, undefined);
  assert.equal(records[0].topicDecision, undefined);
});

test("cancelled model-only entry cannot record or continue generation", async () => {
  const { deps, records } = fixture();
  const controller = new AbortController();
  deps.turnPlanner.decide = async () => { controller.abort(new Error("停止")); return largePlan; };
  await assert.rejects(planGenerationModel(deps as any, { ...input, abortSignal: controller.signal }), /停止/);
  assert.equal(records.length, 0);
});

test("internal model evidence uses the same content projection before calling planner", async () => {
  const { deps, calls } = fixture();
  const contentSafetyService = { async projectPromptMessages(value: any) { return { ...value, recentMessages: value.recentMessages.map((message: any) => ({ ...message, content: "已过滤任务摘要" })), batchMessages: value.batchMessages.map((message: any) => ({ ...message, text: "已过滤触发指令" })) }; } };
  await planGenerationModel({ ...deps, contentSafetyService } as any, input);
  assert.equal(calls[0]!.taskSummary, "已过滤任务摘要");
  assert.equal(calls[0]!.batchMessages[0]!.text, "已过滤触发指令");
  assert.equal(calls[0]!.taskContext?.primary?.objective, "已过滤任务摘要");
  assert.equal(calls[0]!.taskContext?.primary?.taskId, "task-1");
});


test("a decided large route is not silently replaced when the model is unavailable", async () => {
  const { deps, records } = fixture({ largeAvailable: false, answer: largePlan });
  const result = await planGenerationModel(deps as any, input);
  assert.deepEqual(result.resolvedModelRef, ["large"]);
  assert.equal(records[0].modelTier, "large");
  assert.equal(records[0].modelSelectionStatus, "decided");
});
