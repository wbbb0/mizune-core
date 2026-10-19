import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { LlmClient } from "#llm/llmClient.ts";
import { normalizeEmbeddingVectors } from "#llm/provider/openAiCompatEmbedding.ts";
import { ContextEmbeddingService } from "#context/contextEmbeddingService.ts";
import { createLlmTestConfig, withMockFetch } from "../../helpers/llm-test-support.tsx";
import { createTestAppConfig } from "../../helpers/config-fixtures.tsx";

const logger = pino({ level: "silent" });
test("候选模型独立校验预算，小窗口候选不会发请求；输出上限覆盖 extra", async () => {
  const config = createLlmTestConfig([{ model: "small", chat: { limits: { maxInputTokens: 1 } } }, { model: "large", chat: { limits: { contextTokens: 4096, maxOutputTokens: 128 }, defaults: { extra: { max_tokens: 9000, max_completion_tokens: 9000 } } } }]);
  await withMockFetch([{ assertRequest(body: any) { assert.equal(body.model, "large"); assert.equal(body.max_tokens, 128); assert.equal(body.max_completion_tokens, undefined); }, payloads: [{ choices: [{ delta: { content: "通过" } }] }] }], async () => {
    const result = await new LlmClient(config, logger).generate({ messages: [{ role: "user", content: "这是一个超过一个 token 的请求" }], maxOutputTokensOverride: 512 });
    assert.equal(result.text, "通过");
  });
});

test("仅转写子树的模型沿工具循环使用独立参数", async () => {
  const config = createLlmTestConfig();
  const profile = config.llm.models.main!;
  profile.transcription = { ...profile.chat!, defaults: { temperature: 0.2 } };
  delete profile.chat;
  await withMockFetch([{ assertRequest(body: any) { assert.equal(body.temperature, 0.2); }, payloads: [{ choices: [{ delta: { content: "转写结果" } }] }] }], async () => {
    const result = await new LlmClient(config, logger).generate({ operation: "transcription", messages: [{ role: "user", content: "转写" }], modelRefOverride: "main" });
    assert.equal(result.text, "转写结果");
  });
});

test("OpenRouter 独立思考字段参与流响应和开关", async () => {
  const config = createLlmTestConfig(); config.llm.providers.test!.type = "openrouter";
  await withMockFetch([{ assertRequest(body: any) { assert.equal(body.reasoning.enabled, true); }, payloads: [{ choices: [{ delta: { reasoning: "先分析" } }] }, { choices: [{ delta: { content: "答案" } }] }] }], async () => {
    const result = await new LlmClient(config, logger).generate({ messages: [{ role: "user", content: "问题" }], enableThinkingOverride: true });
    assert.equal(result.reasoningContent, "先分析");
  });
});

test("向量响应拒绝错索引、非有限值、数量和维度不一致", () => {
  for (const data of [
    [{ index: 0, embedding: [1] }, { index: 0, embedding: [1] }],
    [{ index: 0, embedding: [1] }, { index: 1, embedding: [1, 2] }],
    [{ index: 0, embedding: [NaN] }, { index: 1, embedding: [1] }],
    [{ index: 0, embedding: [1] }],
    [{ index: 0, embedding: ["1"] }, { index: 1, embedding: [1] }]
  ]) assert.throws(() => normalizeEmbeddingVectors({ data }, 2));
  assert.deepEqual(normalizeEmbeddingVectors({ data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] }, 2), [[1], [2]]);
});

test("Qwen3 查询加任务说明而文档保持原文，两者共享空间；更换接口使空间失效", async () => {
  const config = createTestAppConfig({ llm: { enabled: true, models: { "test/embedding": { embedding: { inputMode: "qwen3", queryInstruction: "检索资料" } } } } });
  const client = new LlmClient(config, logger), service = new ContextEmbeddingService(config, client, logger);
  let index = 0;
  await withMockFetch(Array.from({ length: 4 }, () => ({ assertRequest(body: any) {
    assert.deepEqual(body.input, [index++ === 0 ? "Instruct: 检索资料\nQuery: 测试" : "测试"]);
    assert.equal(body.encoding_format, "float");
  }, response: new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })) })), async () => {
    assert.equal(service.getStatus().health, "untested");
    const query = await service.embedTexts(["测试"], { purpose: "query" });
    const document = await service.embedTexts(["测试"]);
    assert.equal(query.profile.profileId, document.profile.profileId);
    assert.equal(service.getStatus().health, "healthy");
    config.llm.models["test/embedding"]!.embedding!.limits.maxInputTokens = 4000;
    const metadataUpdated = await service.embedTexts(["测试"]);
    assert.equal(document.profile.profileId, metadataUpdated.profile.profileId);
    config.llm.providers.test!.baseUrl = "https://other.example/v1";
    assert.equal(service.getStatus().health, "untested");
    const other = await service.embedTexts(["测试"]);
    assert.notEqual(document.profile.profileId, other.profile.profileId);
  });
});

test("硬输出上限不作为默认预留，小窗口备用模型不压低主模型压缩阈值", async () => {
  const { getModelInputBudget, estimateLlmMessagesTokens } = await import("#llm/shared/requestTokenBudget.ts");
  const { getRoutingPresetTokenLimits } = await import("#llm/shared/modelRouting.ts");
  const config = createLlmTestConfig([{ chat: { limits: { contextTokens: 8192, maxOutputTokens: 8192 } } }, { chat: { limits: { contextTokens: 512 } } }]);
  assert.equal(getModelInputBudget(config.llm.models.main!), 6144);
  config.llm.routingPresets.test!.tokenLimits = { triggerTokens: 7000, retainTokens: 1000 };
  assert.equal(getRoutingPresetTokenLimits(config).triggerTokens, 6144);
  const plain = [{ role: "assistant" as const, content: "结果" }];
  const replay = [{ ...plain[0]!, providerMetadata: { openRouterReasoningDetails: [{ index: 0, type: "reasoning.encrypted", data: "a".repeat(10000) }] } }];
  assert.ok(estimateLlmMessagesTokens(replay, config) > estimateLlmMessagesTokens(plain, config) + 1000);
});

test("Anthropic 思考最低预算在请求前拒绝", async () => {
  const config = createLlmTestConfig({ chat: { limits: { maxOutputTokens: 512 } } });
  config.llm.providers.test!.type = "anthropic";
  await withMockFetch([], async () => {
    await assert.rejects(new LlmClient(config, logger).generate({ messages: [{ role: "user", content: "测试" }], enableThinkingOverride: true }), /至少需要 1024/);
  });
});

test("OpenRouter 工具后续请求回放拼接的 reasoning_details 并明确关闭可控思考", async () => {
  const config = createLlmTestConfig(); config.llm.providers.test!.type = "openrouter";
  await withMockFetch([
    { assertRequest(body: any) { assert.equal(body.reasoning.enabled, false); }, payloads: [
      { choices: [{ delta: { reasoning_details: [{ index: 0, type: "reasoning.encrypted", data: "abc" }] } }] },
      { choices: [{ delta: { reasoning_details: [{ index: 0, type: "reasoning.encrypted", data: "def" }], tool_calls: [{ index: 0, id: "call", type: "function", function: { name: "lookup", arguments: "{}" } }] } }] }
    ] },
    { assertRequest(body: any) {
      assert.equal(body.reasoning.enabled, false);
      const assistant = body.messages.find((message: any) => message.role === "assistant");
      assert.deepEqual(assistant.reasoning_details, [{ index: 0, type: "reasoning.encrypted", data: "abcdef" }]);
    }, payloads: [{ choices: [{ delta: { content: "完成" } }] }] }
  ], async () => {
    const result = await new LlmClient(config, logger).generate({ messages: [{ role: "user", content: "检索" }], toolExecutor: async () => "查询结果", enableThinkingOverride: false });
    assert.equal(result.text, "完成");
  });
});
