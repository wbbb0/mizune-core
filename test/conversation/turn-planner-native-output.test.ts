import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { TurnPlanner } from "../../src/conversation/turnPlanner.ts";
import type { TurnPlannerInput } from "../../src/conversation/turnPlanner/types.ts";
import { buildPlannerQuestions } from "../../src/conversation/turnPlanner/definitions.ts";
import { parseStructuredPlannerResult } from "../../src/conversation/turnPlanner/chat.ts";
import { LlmClient } from "../../src/llm/llmClient.ts";
import { buildTurnPlannerResponseFormat, estimateTurnPlannerOutputTokens } from "../../src/llm/prompts/turn-planner.prompt.ts";
import { createLlmTestConfig, withMockFetch } from "../helpers/llm-test-support.tsx";
import { createReplyGateBatchMessage } from "../helpers/reply-gate-fixtures.tsx";
import { plannerChatFixture } from "../helpers/planner-chat-fixtures.ts";

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
const overrides = { model: "large", task: "pause_current", "toolset:shell": true, "skill:repair": true, "capability:shell_execution": true };
const text = plannerChatFixture(input, overrides, "需要检查构建故障并实际运行宿主机命令。");
function responsesOutput(value: string) {
  return [{ type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: value, annotations: [] }] }] } }];
}

test("native planner schema is generated from all independent questions with task basis first", async () => {
  const config = plannerConfig();
  await withMockFetch([{
    assertRequest(body: any, _index: number, _init: unknown, url: string) {
      assert.match(url, /\/responses$/);
      const format = body.text.format;
      assert.equal(format.type, "json_schema");
      assert.equal(format.strict, true);
      assert.equal(format.schema.additionalProperties, false);
      assert.deepEqual(format.schema.required, ["task_basis", ...buildPlannerQuestions(input).map(({ question }) => question.name)]);
      assert.deepEqual(format.schema.properties.model.enum, ["small", "large", null]);
      assert.deepEqual(format.schema.properties.reply.enum, ["reply", "wait", "no_reply", null]);
      assert.equal(format.schema.properties.task_basis.maxLength, 80);
      assert.match(body.input[0].content[0].text, /必须首先生成 task_basis/);
    }, payloads: responsesOutput(text)
  }], async () => {
    const result = await planner(config).decide(input);
    assert.equal(result.replyDecision, "reply");
    assert.equal(result.modelTier, "large");
    assert.equal(result.modelSelectionStatus, "decided");
    assert.equal(result.taskBasis, "需要检查构建故障并实际运行宿主机命令。");
    assert.equal(result.taskIntent?.kind, "pause_current");
    assert.equal(result.taskIntent?.targetTaskId, "task-1");
    assert.deepEqual(result.toolsetIds, ["shell"]);
    assert.deepEqual(result.skillIds, ["repair"]);
  });
});

test("mixed native routing retains generated schema through OpenAI to Google fallback", async () => {
  const config = plannerConfig();
  config.llm.providers.google_fallback = { ...config.llm.providers.test!, type: "google" };
  config.llm.models.fallback = { ...config.llm.models.main!, provider: "google_fallback", model: "fallback-model" };
  config.llm.routingPresets.test!.turnPlanner = ["main", "fallback"];
  await withMockFetch([{
    assertRequest(body: any) { assert.equal(body.text?.format.type, "json_schema"); },
    response: new Response("upstream busy", { status: 503 })
  }, {
    assertRequest(body: any) {
      assert.ok(body.generationConfig.responseJsonSchema);
      assert.equal(body.generationConfig.responseMimeType, "application/json");
    }, payloads: [{ candidates: [{ content: { parts: [{ text }] } }] }]
  }], async () => {
    const result = await planner(config).decide(input);
    assert.equal(result.modelTier, "large");
    assert.equal(result.taskIntent?.kind, "pause_current");
  });
});

test("ordinary models receive the same JSON protocol without native structured-output support", async () => {
  for (const type of ["openai_compatible", "openai_responses_compatible"] as const) {
    const config = plannerConfig();
    config.llm.providers.test!.type = type;
    delete config.llm.models.main!.chat!.capabilities.supportsStructuredOutput;
    await withMockFetch([{
      assertRequest(body: any) {
        assert.equal(body.response_format, undefined);
        assert.equal(body.text?.format, undefined);
        const system = type === "openai_compatible" ? body.messages[0].content : body.input[0].content[0].text;
        assert.match(system, /严格输出一个 JSON object/);
        assert.match(system, /必须首先生成 task_basis/);
      }, payloads: type === "openai_compatible" ? [{ choices: [{ delta: { content: text }, finish_reason: "stop" }] }] : responsesOutput(text)
    }], async () => { assert.equal((await planner(config).decide(input)).modelTier, "large"); });
  }
});

test("chat parser rejects wrong ordering, extra fields, invalid candidates, missing answers and long basis", () => {
  assert.ok(parseStructuredPlannerResult(text, input));
  assert.equal(parseStructuredPlannerResult(text.replace('"model":"large"', '"model":"small","model":"large"'), input), null);
  const valid = JSON.parse(text);
  const { task_basis, ...answers } = valid;
  for (const value of [
    { ...answers, task_basis }, { ...valid, model: "fast" }, { ...valid, unexpected: true },
    { ...valid, task_basis: "据".repeat(81) }, { task_basis }, { ...valid, "toolset:shell": "yes" }
  ]) assert.equal(parseStructuredPlannerResult(JSON.stringify(value), input), null);
  assert.equal(parseStructuredPlannerResult("reason: 继续回复\nreply_decision: reply_small", input), null);
});

test("unknown answers remain explicit and do not fabricate confidence or model tier", () => {
  const parsed = JSON.parse(text);
  parsed.model = null;
  parsed.task = null;
  const result = parseStructuredPlannerResult(JSON.stringify(parsed), input)!;
  assert.equal(result.modelTier, undefined);
  assert.equal(result.modelSelectionStatus, "undetermined");
  assert.ok(result.undeterminedQuestions?.includes("model"));
  assert.deepEqual(result.taskIntent, { kind: "unknown", confidence: "low" });
});

test("only requested questions are emitted and output budget grows with candidate count", () => {
  const minimal = { requirements: { modelSelection: false, toolSelection: false, replyGate: false, semanticWait: false, topicSwitch: false, taskIntent: false } };
  const format = buildTurnPlannerResponseFormat(minimal);
  if (format.type !== "json_schema") throw new Error("expected schema");
  assert.deepEqual(format.schema.required, ["task_basis"]);
  assert.ok(estimateTurnPlannerOutputTokens(input) >= 512);
  const many = { ...input, availableSkills: Array.from({ length: 100 }, (_, index) => ({ id: `skill-${index}`, name: "技能", description: "处理当前任务" })) };
  assert.ok(estimateTurnPlannerOutputTokens(many) > estimateTurnPlannerOutputTokens(input));
});
