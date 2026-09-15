import test from "node:test";
import assert from "node:assert/strict";
import { getTurnPlannerReasons, resolveTurnPlannerRequirements, type TurnPlannerRequirements } from "../../src/conversation/turnPlannerPolicy.ts";
import { areMainModelRoutesEquivalent } from "../../src/llm/shared/modelRouteEquivalence.ts";
import { resolveModelSelfUpgradePlan } from "../../src/llm/shared/modelSelfUpgrade.ts";
import { handleGenerationTurnPlanner } from "../../src/app/generation/generationTurnPlanner.ts";
import { getBuiltinToolNames } from "../../src/llm/builtinTools.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { createGenerationReplyGateDeps, createGenerationReplyGateHandlers, createGenerationReplyGateInput, createReplyGate, createReplyGateBatchMessage } from "../helpers/reply-gate-fixtures.tsx";

const noRequirements: TurnPlannerRequirements = {
  modelSelection: false, toolSelection: false, replyGate: false,
  semanticWait: false, topicSwitch: false, taskIntent: false
};

function config() {
  return createTestAppConfig({
    llm: { enabled: true, turnPlanner: { enabled: true }, summarizer: { enabled: true } },
    conversation: { historyCompression: { enabled: true } }
  });
}

test("ordinary private turns need no planner with equivalent models and all tools", () => {
  const value = config();
  assert.equal(value.llm.turnPlanner.toolSelection, "all");
  assert.equal(value.llm.turnPlanner.semanticWait, false);
  assert.deepEqual(resolveTurnPlannerRequirements(value, {
    canSkipReply: false, pendingWaitPasses: 0, availableToolsetCount: 15
  }), noRequirements);
});

test("topic planning requires both new raw messages and reclaimable tokens", () => {
  const value = config();
  const needs = (messageCount: number, estimatedReclaimableTokens: number) => resolveTurnPlannerRequirements(value, {
    canSkipReply: false, pendingWaitPasses: 0, availableToolsetCount: 0,
    topicCompressionCandidate: { messageCount, estimatedReclaimableTokens }
  }).topicSwitch;
  assert.equal(needs(5, 10000), false);
  assert.equal(needs(6, 1999), false);
  assert.equal(needs(6, 2000), true);
  value.llm.summarizer.enabled = false;
  assert.equal(needs(6, 10000), false);
});

test("planner combines group, tool, task and optional wait requirements", () => {
  const value = config();
  value.llm.turnPlanner.toolSelection = "planned";
  value.llm.turnPlanner.semanticWait = true;
  const input = {
    canSkipReply: true, pendingWaitPasses: 0, availableToolsetCount: 2,
    taskContext: { parked: [{ taskId: "paused", status: "suspended" as const, objective: "修测试" }] }
  };
  assert.deepEqual(getTurnPlannerReasons(resolveTurnPlannerRequirements(value, input)), ["toolSelection", "replyGate", "semanticWait", "taskIntent"]);
  assert.equal(resolveTurnPlannerRequirements(value, { ...input, pendingWaitPasses: 1 }).semanticWait, false);
  assert.equal(resolveTurnPlannerRequirements(value, { ...input, taskContext: { parked: [] } }).taskIntent, false);
});

test("route equivalence ignores aliases but preserves parameters, providers and fallback order", () => {
  const value = config();
  value.llm.models.alias = structuredClone(value.llm.models.main!);
  value.llm.routingPresets.test!.mainLarge = ["alias"];
  assert.equal(areMainModelRoutesEquivalent(value), true);
  assert.equal(resolveModelSelfUpgradePlan({ config: value, currentModelRefs: ["main"], enabled: true }), null);
  value.llm.models.alias.apiParameters = { temperature: 0.3 };
  assert.equal(areMainModelRoutesEquivalent(value), false);
  assert.ok(resolveModelSelfUpgradePlan({ config: value, currentModelRefs: ["main"], enabled: true }));
  value.llm.models.alias = structuredClone(value.llm.models.main!);
  value.llm.models.alias.provider = "different";
  assert.equal(areMainModelRoutesEquivalent(value), false);
  value.llm.models.alias = structuredClone(value.llm.models.main!);
  value.llm.models.fallback = { ...value.llm.models.main!, model: "fallback" };
  value.llm.routingPresets.test!.mainSmall = ["main", "fallback"];
  value.llm.routingPresets.test!.mainLarge = ["alias", "fallback"];
  assert.equal(areMainModelRoutesEquivalent(value), true);
  value.llm.routingPresets.test!.mainLarge = ["fallback", "alias"];
  assert.equal(areMainModelRoutesEquivalent(value), false);
});

test("a skipped turn never prepares planner media and preserves all allowed toolsets", async () => {
  const value = config();
  let called = false;
  const planner = createReplyGate(value, { onGenerate() { called = true; } });
  const result = await handleGenerationTurnPlanner(
    createGenerationReplyGateDeps({ config: value, turnPlanner: planner }),
    createGenerationReplyGateHandlers(),
    createGenerationReplyGateInput({
      availableToolsets: [{ id: "time_utils", title: "时间", description: "查询时间", toolNames: ["get_current_time"] }],
      batchMessages: [{ ...createGenerationReplyGateInput().batchMessages[0]!, audioSources: [], text: "现在几点", emojiIds: ["file_unloaded"] }]
    })
  );
  assert.equal(called, false);
  assert.equal(result.action, "continue");
  if (result.action === "continue") {
    assert.deepEqual(result.toolsetIds, ["time_utils"]);
    assert.equal(result.plannerDecision, undefined);
  }
});

test("task-only planning omits inactive fields and rejects unsolicited routing, waits and compression", async () => {
  let system = "";
  let user = "";
  const planner = createReplyGate(config(), {
    resultText: "reason: 暂停当前任务\nreply_decision: wait\ntopic_decision: new_topic\ntoolset_ids: shell_runtime\ntask_intent: pause_current|task-1|high",
    onGenerate(input) {
      system = String(input.messages[0]?.content);
      user = JSON.stringify(input.messages[1]?.content);
      assert.equal(input.maxOutputTokensOverride, 512);
    }
  });
  const result = await planner.decide({
    requirements: { ...noRequirements, taskIntent: true },
    sessionId: "test", chatType: "private", relationship: "owner", recentMessages: [],
    taskContext: { primary: { taskId: "task-1", status: "active", objective: "修测试" }, parked: [] },
    availableToolsets: [{ id: "shell_runtime", title: "命令", description: "执行命令", toolNames: ["shell_run"] }],
    batchMessages: [createReplyGateBatchMessage({ text: "先暂停" })]
  });
  assert.doesNotMatch(system, /reply_decision|topic_decision|toolset_ids|planner_model_selection|required_capabilities/);
  assert.doesNotMatch(user, /available_toolsets|shell_run/);
  assert.match(system, /严格输出以下 2 行/);
  assert.equal(result.replyDecision, "reply_small");
  assert.equal(result.topicDecision, "continue_topic");
  assert.deepEqual(result.toolsetIds, []);
  assert.equal(result.taskIntent?.kind, "pause_current");
  assert.ok(result.metrics);
});

test("all mode removes tool discovery and activation tools", () => {
  const value = config();
  const names = ["list_available_toolsets", "request_toolset"];
  assert.deepEqual(getBuiltinToolNames("owner", null, value, { modelRef: ["main"], availableToolNames: names }), []);
  value.llm.turnPlanner.toolSelection = "planned";
  assert.deepEqual(getBuiltinToolNames("owner", null, value, { modelRef: ["main"], availableToolNames: names }).sort(), names);
});
