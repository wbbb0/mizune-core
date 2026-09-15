import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { TurnPlanner } from "../../src/conversation/turnPlanner.ts";
import { resolveTurnPlannerOutputTokenLimit } from "../../src/conversation/turnPlannerPolicy.ts";
import { LlmClient } from "../../src/llm/llmClient.ts";
import { createLlmTestConfig, withMockFetch } from "../helpers/llm-test-support.tsx";
import { createReplyGateBatchMessage } from "../helpers/reply-gate-fixtures.tsx";

test("short planner budgets require every fallback to actually disable thinking", () => {
  const config = createLlmTestConfig({ supportsThinking: false });
  assert.equal(resolveTurnPlannerOutputTokenLimit(config, ["main"]), 512);
  config.llm.models.fallback = { ...config.llm.models.main!, supportsThinking: true, thinkingControllable: false };
  assert.equal(resolveTurnPlannerOutputTokenLimit(config, ["main", "fallback"]), undefined);
  config.llm.models.main!.supportsThinking = true;
  assert.equal(resolveTurnPlannerOutputTokenLimit(config, ["main"]), undefined);
  config.llm.providers.test!.features.thinking = { type: "flag", path: "enable_thinking" };
  assert.equal(resolveTurnPlannerOutputTokenLimit(config, ["main"]), 512);
  config.llm.turnPlanner.enableThinking = true;
  assert.equal(resolveTurnPlannerOutputTokenLimit(config, ["main"]), undefined);
});

test("DashScope short budgets require an explicit thinking control mapping", () => {
  const config = createLlmTestConfig({ supportsThinking: true });
  config.llm.providers.test!.type = "dashscope";
  assert.equal(resolveTurnPlannerOutputTokenLimit(config, ["main"]), undefined);
  config.llm.providers.test!.features.thinking = { type: "flag", path: "enable_thinking" };
  assert.equal(resolveTurnPlannerOutputTokenLimit(config, ["main"]), 512);
});

for (const type of ["google", "openai_responses"] as const) {
  test(`${type} planner preserves the configured output budget when reasoning may remain hidden`, async () => {
    const config = createLlmTestConfig({
      supportsThinking: true,
      thinkingControllable: type === "google",
      apiParameters: { extra: type === "google" ? { maxOutputTokens: 8192 } : { max_output_tokens: 8192 } }
    });
    config.llm.providers.test!.type = type;
    config.llm.turnPlanner.enabled = true;
    config.llm.turnPlanner.enableThinking = false;
    const logger = pino({ level: "silent" });
    const planner = new TurnPlanner(config, new LlmClient(config, logger), { getMany: async () => [] }, {
      prepareFilesForModel: async () => []
    }, logger);
    const text = "reason: 用户要求暂停\ntask_intent: pause_current|task-1|high";
    await withMockFetch([{
      assertRequest(body: Record<string, any>) {
        if (type === "google") {
          assert.equal(body.generationConfig.maxOutputTokens, 8192);
          assert.deepEqual(body.generationConfig.thinkingConfig, { includeThoughts: false });
        } else {
          assert.equal(body.max_output_tokens, 8192);
          assert.equal(body.reasoning, undefined);
        }
      },
      payloads: type === "google"
        ? [{ candidates: [{ content: { parts: [{ text }] } }] }]
        : [{ type: "response.completed", response: {
            id: "planner-budget", status: "completed",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }]
          } }]
    }], async () => {
      const result = await planner.decide({
        requirements: { modelSelection: false, toolSelection: false, replyGate: false, semanticWait: false, topicSwitch: false, taskIntent: true },
        sessionId: "budget-test", chatType: "private", relationship: "owner", recentMessages: [],
        taskContext: { primary: { taskId: "task-1", status: "active", objective: "修复测试" }, parked: [] },
        batchMessages: [createReplyGateBatchMessage({ text: "先暂停" })]
      });
      assert.equal(result.taskIntent?.kind, "pause_current");
    });
  });
}
