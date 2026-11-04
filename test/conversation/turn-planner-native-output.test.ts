import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { TurnPlanner, type TurnPlannerInput } from "../../src/conversation/turnPlanner.ts";
import { LlmClient } from "../../src/llm/llmClient.ts";
import { buildTurnPlannerResponseFormat } from "../../src/llm/prompts/turn-planner.prompt.ts";
import { createLlmTestConfig, withMockFetch } from "../helpers/llm-test-support.tsx";
import { createReplyGateBatchMessage } from "../helpers/reply-gate-fixtures.tsx";

const logger = pino({ level: "silent" });
function plannerConfig() {
  const config = createLlmTestConfig();
  config.llm.providers.test!.type = "openai";
  config.llm.models.main!.chat!.capabilities.supportsStructuredOutput = true;
  config.llm.turnPlanner.enabled = true;
  return config;
}
function planner(config: ReturnType<typeof plannerConfig>) {
  return new TurnPlanner(config, new LlmClient(config, logger), { getMany: async () => [] }, { prepareFilesForModel: async () => [] }, logger);
}
const input: TurnPlannerInput = {
  requirements: { modelSelection: true, toolSelection: true, skillSelection: true, replyGate: true, semanticWait: true, topicSwitch: true, taskIntent: true },
  sessionId: "native-plan", chatType: "private", relationship: "owner", recentMessages: [],
  taskContext: { primary: { taskId: "task-1", status: "active", objective: "修复测试" }, parked: [] },
  availableSkills: [{ id: "repair", name: "修复", description: "处理测试故障" }],
  availableToolsets: [{ id: "shell", title: "终端", description: "执行命令", toolNames: ["shell_run"] }],
  batchMessages: [createReplyGateBatchMessage({ text: "暂停当前任务，先帮我检查构建失败" })]
};
const planFields = {
  reason: "先检查构建故障", reply_decision: "reply_large", topic_decision: "continue_topic",
  task_intent: "pause_current|task-1|high", skill_ids: "repair", required_capabilities: "shell_execution",
  context_dependencies: "prior_shell_context", recent_domain_reuse: "shell", followup_mode: "explicit_reference", toolset_ids: "shell"
};
function responsesOutput(text: string) {
  return [{ type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text, annotations: [] }] }] } }];
}

test("native planner sends a strict schema and parses the actual Responses JSON result", async () => {
  const config = plannerConfig();
  await withMockFetch([{
    assertRequest(body: any, _index: number, _init: unknown, url: string) {
      assert.match(url, /\/responses$/);
      const format = body.text.format;
      assert.equal(format.type, "json_schema");
      assert.equal(format.strict, true);
      assert.equal(format.schema.additionalProperties, false);
      assert.deepEqual(format.schema.required.sort(), Object.keys(planFields).sort());
      assert.deepEqual(format.schema.properties.reply_decision.enum, ["reply_small", "reply_large", "wait", "no_reply"]);
      assert.match(body.input[0].content[0].text, /严格输出一个 JSON object/);
      assert.doesNotMatch(body.input[0].content[0].text, /严格输出以下 \d+ 行/);
    },
    payloads: responsesOutput(JSON.stringify(planFields))
  }], async () => {
    const result = await planner(config).decide(input);
    assert.equal(result.replyDecision, "reply_large");
    assert.equal(result.reason, planFields.reason);
    assert.equal(result.taskIntent?.kind, "pause_current");
    assert.equal(result.taskIntent?.targetTaskId, "task-1");
    assert.deepEqual(result.toolsetIds, ["shell"]);
    assert.deepEqual(result.skillIds, ["repair"]);
    assert.deepEqual(result.requiredCapabilities, ["shell_execution"]);
  });
});

test("mixed planner routing retains the shared text contract through an OpenAI to Google fallback", async () => {
  const config = plannerConfig();
  config.llm.providers.google_fallback = { ...config.llm.providers.test!, type: "google" };
  config.llm.models.fallback = { ...config.llm.models.main!, provider: "google_fallback", model: "fallback-model" };
  config.llm.routingPresets.test!.turnPlanner = ["main", "fallback"];
  const text = Object.entries(planFields).map(([key, value]) => `${key}: ${value}`).join("\n");
  await withMockFetch([{
    assertRequest(body: any) {
      assert.equal(body.text?.format, undefined);
      assert.match(body.input[0].content[0].text, /严格输出以下 \d+ 行/);
    },
    response: new Response("upstream busy", { status: 503 })
  }, {
    assertRequest(body: any, _index: number, _init: unknown, url: string) {
      assert.match(url, /streamGenerateContent/);
      assert.equal(body.generationConfig.responseSchema, undefined);
      assert.equal(body.generationConfig.responseMimeType, undefined);
    },
    payloads: [{ candidates: [{ content: { parts: [{ text }] } }] }]
  }], async () => {
    const result = await planner(config).decide(input);
    assert.equal(result.replyDecision, "reply_large");
    assert.equal(result.taskIntent?.kind, "pause_current");
    assert.deepEqual(result.toolsetIds, ["shell"]);
  });
});

test("native planner schema omits decisions not requested by this turn", () => {
  const format = buildTurnPlannerResponseFormat({ modelSelection: false, toolSelection: false, replyGate: false, semanticWait: false, topicSwitch: false, taskIntent: true }, false);
  assert.equal(format.type, "json_schema");
  if (format.type !== "json_schema") return;
  assert.deepEqual(format.schema.required, ["reason"]);
  assert.deepEqual(Object.keys(format.schema.properties as object), ["reason"]);
});

test("compatible planner models without an explicit structured-output capability retain the existing protocol", async () => {
  for (const type of ["openai_compatible", "openai_responses_compatible"] as const) {
    const config = plannerConfig();
    config.llm.providers.test!.type = type;
    delete config.llm.models.main!.chat!.capabilities.supportsStructuredOutput;
    const text = Object.entries(planFields).map(([key, value]) => `${key}: ${value}`).join("\n");
    await withMockFetch([{
      assertRequest(body: any) {
        assert.equal(body.response_format, undefined);
        assert.equal(body.text?.format, undefined);
        const system = type === "openai_compatible" ? body.messages[0].content : body.input[0].content[0].text;
        assert.match(system, /严格输出以下 \d+ 行/);
      },
      payloads: type === "openai_compatible" ? [{ choices: [{ delta: { content: text }, finish_reason: "stop" }] }] : responsesOutput(text)
    }], async () => {
      const result = await planner(config).decide(input);
      assert.equal(result.replyDecision, "reply_large");
      assert.equal(result.taskIntent?.kind, "pause_current");
    });
  }
});
