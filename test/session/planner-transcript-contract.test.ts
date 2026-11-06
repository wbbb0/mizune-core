import test from "node:test";
import assert from "node:assert/strict";
import { internalTranscriptItemSchema, transcriptGateDecisionItemSchema, transcriptModelRouteEventItemSchema } from "../../src/conversation/session/transcriptContract.ts";
import { createModelPolicyRouteEvent, createModelSelfUpgradeRouteEvent } from "../../src/conversation/session/internalTranscriptEvents.ts";
import { getProviderTranscriptProjector } from "../../src/app/generation/providerTranscriptProjector.ts";

const gate = {
  kind: "gate_decision", llmVisible: false, action: "continue", reason: "模型档位未判定", timestampMs: 1,
  replyDecision: "reply", modelTier: "large", modelSelectionStatus: "undetermined",
  taskBasis: "需要读取宿主机文件，确认服务异常。", undeterminedQuestions: ["model_tier"]
} as const;

test("planner transcript preserves independent decisions and task basis through serialization", () => {
  const parsed = internalTranscriptItemSchema.parse(JSON.parse(JSON.stringify(gate)));
  assert.equal(parsed.kind, "gate_decision");
  if (parsed.kind !== "gate_decision") return;
  assert.equal(parsed.replyDecision, "reply");
  assert.equal(parsed.modelTier, "large");
  assert.equal(parsed.modelSelectionStatus, "undetermined");
  assert.equal(parsed.taskBasis, gate.taskBasis);
  assert.deepEqual(parsed.undeterminedQuestions, ["model_tier"]);
  assert.equal(transcriptGateDecisionItemSchema.safeParse({ ...gate, taskBasis: "字".repeat(81) }).success, false);
  assert.equal(transcriptGateDecisionItemSchema.safeParse({ ...gate, taskBasis: "😀".repeat(80) }).success, true);
  assert.equal(transcriptGateDecisionItemSchema.safeParse({ ...gate, modelSelectionStatus: "guessed" }).success, false);
});

test("policy route events distinguish deferred execution from unavailable routing", () => {
  const event = createModelPolicyRouteEvent({
    reason: "命令执行需要完整模型", fromModelRefs: ["small"], toModelRefs: ["large"],
    provider: "provider_a", toolName: "terminal_run", sourceModelRef: "small", timestampMs: 2
  });
  const parsed = transcriptModelRouteEventItemSchema.parse(event);
  assert.equal(parsed.routeType, "policy_upgrade");
  assert.equal(parsed.executed, false);
  assert.equal(parsed.sourceModelRef, "small");
  assert.equal(transcriptModelRouteEventItemSchema.safeParse({ ...event, toModelRefs: [] }).success, false);
  assert.equal(transcriptModelRouteEventItemSchema.safeParse({ ...event, executed: undefined }).success, false);
  const unavailable = createModelPolicyRouteEvent({
    reason: "没有可用的完整模型", fromModelRefs: ["small"], toModelRefs: [],
    toolName: "terminal_run", unavailable: true
  });
  assert.equal(transcriptModelRouteEventItemSchema.parse(unavailable).routeType, "policy_unavailable");
  assert.deepEqual(unavailable.toModelRefs, []);
  assert.equal(unavailable.provider, undefined);
});

test("existing self upgrade events keep their original contract", () => {
  const event = createModelSelfUpgradeRouteEvent({ reason: "复杂推理", fromModelRefs: ["small"], toModelRefs: ["large"], provider: "test" });
  assert.deepEqual(transcriptModelRouteEventItemSchema.parse(event), event);
  assert.equal(event.routeType, "self_upgrade");
  assert.equal(event.executed, undefined);
});

test("planner task basis and policy routing metadata never enter model history replay", () => {
  const transcript = [internalTranscriptItemSchema.parse(gate), createModelPolicyRouteEvent({
    reason: "命令执行需要完整模型", fromModelRefs: ["small"], toModelRefs: ["large"],
    provider: "test", toolName: "terminal_run", sourceModelRef: "small"
  })];
  for (const type of ["deepseek", "anthropic", "google"] as const) {
    const projection = getProviderTranscriptProjector(type).project({ transcript });
    assert.deepEqual(projection.replayMessages, []);
    assert.deepEqual(projection.lateSystemMessages, []);
  }
});
