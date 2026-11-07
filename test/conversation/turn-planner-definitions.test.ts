import test from "node:test";
import assert from "node:assert/strict";
import { applyPlannerAnswers, buildPlannerQuestions, canUseNativePlannerQuestions } from "../../src/conversation/turnPlanner/definitions.ts";
import type { PlannerDefinitionInput } from "../../src/conversation/turnPlanner/definitions.ts";
import { buildTurnPlannerPrompt } from "../../src/llm/prompts/turn-planner.prompt.ts";
import { createReplyGateBatchMessage } from "../helpers/reply-gate-fixtures.tsx";
const input: PlannerDefinitionInput = { requirements: { modelSelection: true, replyGate: false, semanticWait: false, topicSwitch: false, taskIntent: false, toolSelection: false } };

test("model and response actions use independent questions with described choice boundaries", () => {
  const definitions = buildPlannerQuestions({ ...input, requirements: { ...input.requirements, replyGate: true, semanticWait: true } });
  const model = definitions.find(({ question }) => question.name === "model")!.question;
  const reply = definitions.find(({ question }) => question.name === "reply")!.question;
  assert.equal(model.type, "choice");
  assert.equal(reply.type, "choice");
  if (model.type !== "choice" || reply.type !== "choice") return;
  assert.deepEqual(model.choices.map(choice => choice.value), ["small", "large"]);
  assert.deepEqual(reply.choices.map(choice => choice.value), ["reply", "wait", "no_reply"]);
  assert.ok(model.choices.every(choice => choice.description));
  assert.match(model.choices[1]!.description!, /宿主机通用文件路径/);
  assert.match(model.choices[0]!.description!, /受限临时工作区/);
  const plan = applyPlannerAnswers(input, definitions, new Map([["reply", { value: "no_reply" }], ["model", { value: "large" }]]));
  assert.equal(plan.replyDecision, "no_reply");
  assert.equal(plan.modelTier, "large");
});

test("native confidence and selected-option probability are both required for a decided model tier", () => {
  const definitions = buildPlannerQuestions(input);
  for (const answer of [{ value: "small", confidence: 0.95, probability: 0.6 }, { value: "large", confidence: 0.6, probability: 0.95 }, { value: null }]) {
    const plan = applyPlannerAnswers(input, definitions, new Map([["model", answer]]));
    assert.equal(plan.modelTier, undefined);
    assert.equal(plan.modelSelectionStatus, "undetermined");
    assert.deepEqual(plan.undeterminedQuestions, ["model"]);
  }
});

test("existing RP selection override remains in the shared model question", () => {
  const question = buildPlannerQuestions({ ...input, modeId: "stateful_rp" })[0]!.question;
  assert.match(String(question.instructions), /# 开头的场外指令/);
  assert.match(String(question.instructions), /换装或私密道具互动/);
});

test("all mode exposes operation boundaries without asking tool-selection questions", () => {
  const messages = buildTurnPlannerPrompt({ ...input, sessionId: "test", chatType: "private", relationship: "owner", recentMessages: [],
    batchMessages: [createReplyGateBatchMessage({ text: "帮我查询公开资料" })], availableToolsets: [], visualInputs: [],
    operationSummary: ["当前允许读取公开网页；宿主机操作要求完整模型。"],
    batchAnalysis: { summaryTags: [], audioMessageCount: 0, imageMessageCount: 0, emojiMessageCount: 0, forwardMessageCount: 0, fileMessageCount: 0, specialSegmentMessageCount: 0, replyReferenceCount: 0, mentionMessageCount: 0 }
  });
  assert.match(JSON.stringify(messages[1]), /宿主机操作要求完整模型/);
  assert.doesNotMatch(String(messages[0]?.content), /toolset:/);
});

test("native limits check both total questions and the choice count before requesting", () => {
  assert.equal(canUseNativePlannerQuestions(buildPlannerQuestions(input)), true);
  assert.equal(canUseNativePlannerQuestions(buildPlannerQuestions({ ...input, requirements: { ...input.requirements, skillSelection: true }, availableSkills: Array.from({ length: 401 }, (_, index) => ({ id: `${index}`, name: "技能", description: "方法" })) })), false);
  assert.equal(canUseNativePlannerQuestions(buildPlannerQuestions({ ...input, requirements: { ...input.requirements, taskIntent: true }, taskContext: { parked: Array.from({ length: 250 }, (_, index) => ({ taskId: `${index}`, status: "suspended", objective: "任务" })) } })), false);
});
