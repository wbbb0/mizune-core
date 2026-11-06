import { plannerChatFixture } from "../helpers/planner-chat-fixtures.ts";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { createLogger } from "../../src/logger.ts";
import { recordGenerationPlannerDecision } from "../../src/app/generation/generationModelPlanner.ts";
import { TurnPlanner } from "../../src/conversation/turnPlanner.ts";
import type { TurnPlannerInput } from "../../src/conversation/turnPlanner/types.ts";
import type { DecisionAnswer, LlmDecideParams } from "../../src/llm/provider/nativeCapabilityTypes.ts";
import { LlmClient } from "../../src/llm/llmClient.ts";
import { transcriptGateDecisionItemSchema } from "../../src/conversation/session/transcriptContract.ts";
import { setFetchImplementationForTests } from "../../src/services/proxy/index.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { createReplyGateBatchMessage } from "../helpers/reply-gate-fixtures.tsx";
import { createSseResponse } from "../helpers/llm-test-support.tsx";

afterEach(() => setFetchImplementationForTests(null));
const logger = pino({ level: "silent" });
const baseInput: TurnPlannerInput = {
  requirements: { modelSelection: true, replyGate: true, semanticWait: true, topicSwitch: true, taskIntent: true, toolSelection: true, skillSelection: true },
  sessionId: "decision-test", chatType: "group", relationship: "owner", recentMessages: [],
  availableToolsets: [{ id: "shell_runtime", title: "终端", description: "执行命令", toolNames: ["shell_run"] }],
  availableSkills: [1, 2, 3, 4].map(n => ({ id: `skill-${n}`, name: `技能${n}`, description: "处理当前任务" })),
  taskContext: {
    primary: { taskId: "current", status: "active", objective: "修复构建" },
    parked: [{ taskId: "parked", status: "suspended", objective: "更新依赖" }]
  },
  batchMessages: [createReplyGateBatchMessage({ text: "继续处理刚才的构建" })]
};

function setup() {
  const config = createTestAppConfig({ llm: {
    enabled: true, decision: { enabled: false }, turnPlanner: { enabled: true, timeoutMs: 2000 },
    providers: { official: { type: "openai", apiKey: "test-only", baseUrl: "https://planner.example/v1" } },
    models: { judge: { provider: "official", model: "decision-test", decision: {} } },
    routingPresets: { test: { decision: ["judge"] } }
  }, skills: { enabled: true, plannerSelectionEnabled: true } });
  const client = new LlmClient(config, logger);
  const planner = new TurnPlanner(config, client, { getMany: async () => [] }, { prepareFilesForModel: async () => [] }, logger);
  return { config, client, planner };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function decisionResponse(request: LlmDecideParams, overrides: Record<string, string | number | "refusal"> = {}, confidence = 0.95) {
  const answers: DecisionAnswer[] = request.questions.map(question => {
    const value = overrides[question.name];
    if (value === "refusal") return { name: question.name, type: "refusal" };
    if (question.type === "predicate") return { name: question.name, type: "predicate", probability: typeof value === "number" ? value : 0.1 };
    assert.equal(question.type, "choice");
    const choice = value ?? question.choices[0]!.value;
    return { name: question.name, type: "choice", choice: String(choice), confidence,
      probabilities: question.choices.map(item => ({ value: item.value, probability: item.value === choice ? confidence : (1 - confidence) / (question.choices.length - 1) })) };
  });
  return Response.json({ answers, usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 } });
}

function chatResponse() {
  return createSseResponse([{ choices: [{ delta: { content: plannerChatFixture(baseInput, { model: "large" }) }, finish_reason: "stop" }] }]);
}

test("有效 decision 路由自动接管一次完整规划，工具可见性开关不影响内部选路", async () => {
  const { config, planner } = setup();
  assert.equal(config.llm.decision.enabled, false);
  let calls = 0;
  setFetchImplementationForTests(async (url, init) => {
    calls++;
    assert.equal(url, "https://planner.example/v1/decisions");
    const request: LlmDecideParams & { model: string } = JSON.parse(String(init?.body));
    assert.equal(request.model, "decision-test");
    assert.doesNotMatch(JSON.stringify(request.input), /严格输出以下|严格输出一个 JSON/);
    assert.ok(request.questions.some(question => question.name === "skill:skill-1"));
    return decisionResponse(request, {
      model: "large", task: "restore_parked:parked", "toolset:shell_runtime": 0.6,
      "capability:shell_execution": 0.9, "dependency:prior_shell_context": 0.8,
      "reuse:shell_runtime": 0.8, followup: "explicit_reference",
      "skill:skill-1": 0.71, "skill:skill-2": 0.9, "skill:skill-3": 0.8, "skill:skill-4": 0.95
    });
  });
  const result = await planner.decide(baseInput);
  assert.equal(calls, 1);
  assert.equal(result.modelTier, "large");
  assert.deepEqual(result.taskIntent, { kind: "restore_parked", confidence: "high", targetTaskId: "parked" });
  assert.deepEqual(result.toolsetIds, ["shell_runtime"]);
  assert.deepEqual(result.requiredCapabilities, ["shell_execution"]);
  assert.deepEqual(result.contextDependencies, ["prior_shell_context"]);
  assert.deepEqual(result.recentDomainReuse, ["shell_runtime"]);
  assert.equal(result.followupMode, "explicit_reference");
  assert.deepEqual(result.skillIds, ["skill-4", "skill-2", "skill-3"]);
  assert.equal(result.metrics?.backend, "decision");
  assert.equal(result.metrics?.modelRef, "judge");
  assert.equal(result.metrics?.inputTokens, 20);
  const persisted = transcriptGateDecisionItemSchema.parse({
    kind: "gate_decision", llmVisible: false, action: "continue", reason: result.reason,
    plannerMetrics: result.metrics, timestampMs: Date.now()
  });
  assert.equal(persisted.plannerMetrics?.backend, "decision");
  assert.equal(persisted.plannerMetrics?.modelRef, "judge");
});

test("仅配置 decision 也能启用规划；没有本轮职责或关闭规划时不调用模型和媒体", async () => {
  const { config, planner } = setup();
  config.llm.routingPresets.test!.turnPlanner = [];
  assert.equal(planner.isEnabled(), true);
  let calls = 0;
  setFetchImplementationForTests(async (_url, init) => {
    calls++;
    const request: LlmDecideParams = JSON.parse(String(init?.body));
    assert.deepEqual(request.questions.map(question => question.name), ["model"]);
    return decisionResponse(request);
  });
  const input = { ...baseInput, requirements: { modelSelection: true, toolSelection: false, replyGate: false, semanticWait: false, topicSwitch: false, taskIntent: false } };
  assert.equal((await planner.decide(input)).metrics?.backend, "decision");
  assert.equal(calls, 1);
  const skipped = await planner.decide({ ...input, requirements: { ...input.requirements, modelSelection: false } });
  assert.equal(skipped.metrics, undefined);
  config.llm.turnPlanner.enabled = false;
  assert.equal(planner.isEnabled(), false);
  await planner.decide(baseInput);
  assert.equal(calls, 1);
});

for (const disable of ["route", "capability"] as const) {
  test(`decision ${disable} 不可用时直接使用聊天模型`, async () => {
    const { config, planner } = setup();
    if (disable === "route") config.llm.routingPresets.test!.decision = [];
    else { config.llm.providers.unsupported = { ...config.llm.providers.official!, type: "anthropic" }; config.llm.models.judge!.provider = "unsupported"; }
    let calls = 0;
    setFetchImplementationForTests(async url => { calls++; assert.match(String(url), /chat\/completions$/); return chatResponse(); });
    const result = await planner.decide(baseInput);
    assert.equal(calls, 1);
    assert.equal(result.modelTier, "large");
    assert.equal(result.metrics?.backend, "chat");
    assert.equal(result.metrics?.fallbackReason, undefined);
  });
}

test("独立判断拒绝保留保守结果，工具候选不会被误判为不需要", async () => {
  const { planner } = setup();
  let calls = 0;
  setFetchImplementationForTests(async (_url, init) => {
    calls++;
    const request: LlmDecideParams = JSON.parse(String(init?.body));
    return decisionResponse(request, Object.fromEntries(request.questions.map(question => [question.name, "refusal"])));
  });
  const result = await planner.decide(baseInput);
  assert.equal(calls, 1);
  assert.equal(result.replyDecision, "reply");
  assert.equal(result.topicDecision, "continue_topic");
  assert.deepEqual(result.taskIntent, { kind: "unknown", confidence: "low" });
  assert.deepEqual(result.toolsetIds, ["shell_runtime"]);
  assert.deepEqual(result.skillIds, []);
  assert.match(result.reason, /部分判断未确定/);
  assert.equal(result.modelSelectionStatus, "undetermined");
});

test("低置信度不会跳过回复、等待、切换话题或改变任务", async () => {
  const { planner } = setup();
  setFetchImplementationForTests(async (_url, init) => decisionResponse(JSON.parse(String(init?.body)), {
    reply: "no_reply", topic: "new_topic", task: "cancel_current"
  }, 0.6));
  const result = await planner.decide(baseInput);
  assert.equal(result.replyDecision, "reply");
  assert.equal(result.topicDecision, "continue_topic");
  assert.deepEqual(result.taskIntent, { kind: "unknown", confidence: "low" });
});

for (const scenario of [
  { name: "群聊闲聊可跳过", message: { text: "只是随口聊聊" }, chatType: "group", choice: "no_reply", expected: "no_reply" },
  { name: "私聊必须回复", message: { text: "只是随口聊聊" }, chatType: "private", choice: "no_reply", expected: "reply" },
  { name: "明确提及必须回复", message: { text: "帮我看看", mentionedSelf: true }, chatType: "group", choice: "no_reply", expected: "reply" },
  { name: "未完文本允许等待", message: { text: "比如说" }, chatType: "private", choice: "wait", expected: "wait" },
  { name: "完整消息不能等待", message: { text: "完成了，谢谢" }, chatType: "private", choice: "wait", expected: "reply" },
  { name: "引用不能按短文本等待", message: { text: "比如说", replyMessageId: "message-1" }, chatType: "private", choice: "wait", expected: "reply" }
] as const) {
  test(`decision 与聊天模型共用规则：${scenario.name}`, async () => {
    const { planner } = setup();
    setFetchImplementationForTests(async (_url, init) => decisionResponse(JSON.parse(String(init?.body)), { reply: scenario.choice, topic: "new_topic" }));
    const result = await planner.decide({ ...baseInput, chatType: scenario.chatType, batchMessages: [createReplyGateBatchMessage(scenario.message)] });
    assert.equal(result.replyDecision, scenario.expected);
    if (scenario.expected === "no_reply" || scenario.expected === "wait") {
      assert.equal(result.topicDecision, "continue_topic");
      assert.deepEqual(result.toolsetIds, []);
    }
  });
}

test("decision 请求失败在剩余预算内降级聊天，失败请求用量保持未知", async () => {
  const { planner } = setup();
  const paths: string[] = [];
  setFetchImplementationForTests(async url => {
    paths.push(String(url));
    return paths.length === 1 ? new Response("upstream busy", { status: 503 }) : chatResponse();
  });
  const result = await planner.decide(baseInput);
  assert.equal(paths.length, 2);
  assert.match(paths[0]!, /decisions$/);
  assert.match(paths[1]!, /chat\/completions$/);
  assert.equal(result.modelTier, "large");
  assert.equal(result.metrics?.backend, "chat");
  assert.equal(result.metrics?.fallbackReason, "decision_failed");
  assert.equal(result.metrics?.inputTokens, null);
});

test("答案契约损坏可降级，聊天规划仍不能恢复不存在的任务", async () => {
  const { planner } = setup();
  let calls = 0;
  setFetchImplementationForTests(async () => {
    calls++;
    return calls === 1 ? Response.json({ answers: [] }) : createSseResponse([{ choices: [{ delta: {
      content: plannerChatFixture(baseInput, { task: null })
    }, finish_reason: "stop" }] }]);
  });
  const result = await planner.decide(baseInput);
  assert.equal(calls, 2);
  assert.deepEqual(result.taskIntent, { kind: "unknown", confidence: "low" });
  assert.equal(result.metrics?.fallbackReason, "decision_failed");
});

test("候选超出原生问题上限时调用前选择聊天规划", async () => {
  const { planner } = setup();
  let calls = 0;
  setFetchImplementationForTests(async url => { calls++; assert.match(String(url), /chat\/completions$/); return chatResponse(); });
  const result = await planner.decide({ ...baseInput, availableSkills: Array.from({ length: 401 }, (_, index) => ({ id: `skill-${index}`, name: "技能", description: "候选技能" })) });
  assert.equal(calls, 1);
  assert.equal(result.metrics?.fallbackReason, "question_limit");
});

test("调用方取消立即退出，不能降级或产生迟到结果", async () => {
  const { planner } = setup();
  const controller = new AbortController();
  const reason = new Error("用户取消");
  let calls = 0;
  setFetchImplementationForTests(async (_url, init) => {
    calls++;
    controller.abort(reason);
    throw init!.signal!.reason;
  });
  await assert.rejects(planner.decide({ ...baseInput, abortSignal: controller.signal }), error => error === reason);
  assert.equal(calls, 1);
  await assert.rejects(planner.decide({ ...baseInput, abortSignal: controller.signal }), error => error === reason);
  assert.equal(calls, 1);
});

test("整个规划共享期限，即使上游忽略取消也不增加一次聊天调用", async () => {
  const { config, planner } = setup();
  config.llm.turnPlanner.timeoutMs = 40;
  const response = deferred<Response>();
  let calls = 0;
  setFetchImplementationForTests(async () => { calls++; return response.promise; });
  const result = await planner.decide(baseInput);
  assert.equal(result.reason, "规划失败，继续回复");
  assert.equal(result.modelSelectionStatus, "undetermined");
  assert.equal(result.modelTier, undefined);
  assert.equal(result.metrics?.backend, "decision");
  assert.equal(result.metrics?.fallbackReason, undefined);
  assert.equal(calls, 1);
  response.resolve(Response.json({ answers: [] }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
});

test("取消媒体准备时不会继续请求模型", async () => {
  const { config, client } = setup();
  const controller = new AbortController();
  const pending = deferred<never[]>();
  const reason = new Error("取消媒体准备");
  const planner = new TurnPlanner(config, client, { getMany: async () => {
    controller.abort(reason);
    return pending.promise;
  } }, { prepareFilesForModel: async () => { throw new Error("不应继续处理媒体"); } }, logger);
  let calls = 0;
  setFetchImplementationForTests(async () => { calls++; throw new Error("不应调用模型"); });
  await assert.rejects(planner.decide({ ...baseInput, abortSignal: controller.signal,
    batchMessages: [createReplyGateBatchMessage({ imageIds: ["visible-image"] })]
  }), error => error === reason);
  pending.resolve([]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
});

test("直接视觉只读取可见媒体，折叠的引用和转发不会进入 decision 证据", async () => {
  const { config, client } = setup();
  let readIds: string[] = [];
  const planner = new TurnPlanner(config, client, {
    getMany: async ids => { readIds = ids; return ids.map(fileId => ({ fileId })) as never; }
  }, {
    prepareFilesForModel: async ids => ids.map(fileId => ({ fileId, inputUrl: "data:image/png;base64,dGVzdA==", kind: "image", transport: "data_url", animated: false, durationMs: null, sampledFrameCount: null }))
  }, logger);
  let calls = 0;
  setFetchImplementationForTests(async (_url, init) => {
    calls++;
    const request: LlmDecideParams = JSON.parse(String(init?.body));
    const evidence = JSON.stringify(request.input);
    assert.doesNotMatch(evidence, /hidden-image|隐藏内容/);
    assert.equal((evidence.match(/input_image/g) ?? []).length, 2);
    return decisionResponse(request);
  });
  const result = await planner.decide({ ...baseInput, batchMessages: [createReplyGateBatchMessage({
    imageIds: ["visible-image", "hidden-image"], emojiIds: ["visible-emoji"],
    contentParts: [
      { kind: "image", fileId: "visible-image" }, { kind: "emoji", fileId: "visible-emoji" },
      { kind: "embedded_message", relation: "forward", parts: [{ kind: "text", text: "隐藏内容" }, { kind: "image", fileId: "hidden-image" }] }
    ]
  })] });
  assert.equal(calls, 1);
  assert.deepEqual(readIds, ["visible-image", "visible-emoji"]);
  assert.equal(result.metrics?.imageInputCount, 1);
  assert.equal(result.metrics?.emojiInputCount, 1);
});

test("降级到无视觉的聊天链时重新准备描述，不能复用直接图片输入", async () => {
  const { config, client } = setup();
  let captionCalls = 0;
  const planner = new TurnPlanner(config, client, { getMany: async ids => ids.map(fileId => ({ fileId })) as never }, {
    prepareFilesForModel: async ids => ids.map(fileId => ({ fileId, inputUrl: "data:image/png;base64,dGVzdA==", kind: "image", transport: "data_url", animated: false, durationMs: null, sampledFrameCount: null }))
  }, logger, { ensureReady: async ids => { captionCalls++; return new Map(ids.map(id => [id, "合成图表描述"])); } });
  let calls = 0;
  setFetchImplementationForTests(async (_url, init) => {
    calls++;
    const request = JSON.parse(String(init?.body));
    if (calls === 1) {
      assert.match(JSON.stringify(request.input), /input_image/);
      return new Response("upstream busy", { status: 503 });
    }
    assert.match(JSON.stringify(request.messages), /合成图表描述/);
    assert.doesNotMatch(JSON.stringify(request.messages), /data:image/);
    return chatResponse();
  });
  const result = await planner.decide({ ...baseInput, batchMessages: [createReplyGateBatchMessage({ imageIds: ["visible-image"] })] });
  assert.equal(calls, 2);
  assert.equal(captionCalls, 1);
  assert.equal(result.metrics?.backend, "chat");
  assert.equal(result.metrics?.imageInputCount, 0);
  assert.equal(result.metrics?.mediaCaptionCount, 1);
});

test("聊天降级只获得整个规划阶段剩余的超时预算", async () => {
  const { config, client, planner } = setup();
  let chatTimeout: number | undefined;
  const generate = client.generate.bind(client);
  client.generate = async params => { chatTimeout = params.timeoutMsOverride; return generate(params); };
  let calls = 0;
  setFetchImplementationForTests(async () => {
    calls++;
    if (calls === 1) {
      await new Promise(resolve => setTimeout(resolve, 30));
      return new Response("upstream busy", { status: 503 });
    }
    return chatResponse();
  });
  const result = await planner.decide(baseInput);
  assert.equal(result.modelTier, "large");
  assert.equal(calls, 2);
  assert.ok(chatTimeout && chatTimeout <= config.llm.turnPlanner.timeoutMs - 25);
});

for (const answer of ["wait", null] as const) {
  test(`等待依据只来自独立回复选择而非展示理由：${answer}`, async () => {
    const { config, planner } = setup();
    config.llm.routingPresets.test!.decision = [];
    setFetchImplementationForTests(async () => createSseResponse([{ choices: [{ delta: {
      content: plannerChatFixture(baseInput, { reply: answer }, "无需回复，只是确认。")
    }, finish_reason: "stop" }] }]));
    const result = await planner.decide({ ...baseInput, batchMessages: [createReplyGateBatchMessage({ text: "比如说" })] });
    assert.equal(result.replyDecision, answer === "wait" ? "wait" : "reply");
  });
}

for (const sample of [
  { small: 0.6, large: 0.4, choice: "large", expected: "small" },
  { small: 0.45, large: 0.55, choice: "small", expected: "large" },
  { small: 0.5, large: 0.5, choice: "small", expected: "large" },
  { small: 0, large: 1, choice: "small", expected: "large" }
] as const) test(`选模采用最大概率并记录原始数值：${sample.small}/${sample.large}`, async () => {
  const { config, client } = setup();
  config.logLevel = "info";
  const logs: string[] = [];
  const logger = createLogger(config, { destination: { write(line) { logs.push(line); } } });
  const planner = new TurnPlanner(config, client, { getMany: async () => [] }, { prepareFilesForModel: async () => [] }, logger);
  setFetchImplementationForTests(async (_url, init) => {
    const request: LlmDecideParams = JSON.parse(String(init?.body));
    const response = await decisionResponse(request, {}, 0.95).json();
    const model = response.answers.find((answer: { name: string }) => answer.name === "model");
    Object.assign(model, { choice: sample.choice, confidence: 0.1,
      probabilities: [{ value: "large", probability: sample.large }, { value: "small", probability: sample.small }] });
    return Response.json(response);
  });
  const result = await planner.decide(baseInput);
  const scores = { small: sample.small, large: sample.large, confidence: 0.1 };
  assert.equal(result.modelTier, sample.expected);
  assert.equal(result.modelSelectionStatus, "decided");
  assert.ok(!result.undeterminedQuestions?.includes("model"));
  assert.deepEqual(result.modelSelectionScores, scores);
  const log = logs.map(line => JSON.parse(line)).find(record => record.msg === "turn_planner_decided");
  assert.deepEqual(log.modelSelectionScores, scores);
  assert.equal(log.modelTier, sample.expected);
  let record: unknown;
  recordGenerationPlannerDecision({ sessionManager: { appendInternalTranscript(_id: string, item: unknown) { record = item; } } as never, persistSession() {} },
    { sessionId: baseInput.sessionId, planner: result, action: "continue", plannerReasons: ["modelSelection"] });
  const stored = transcriptGateDecisionItemSchema.parse(record);
  assert.equal(stored.modelTier, sample.expected);
  assert.deepEqual(stored.modelSelectionScores, scores);
});
