import { llmCatalogFileSchema } from "#config/configModel.ts";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { ApiError } from "@google/genai";
import { createLlmTestConfig, createSseResponse, createToolDefinition, withMockFetch } from "../../helpers/llm-test-support.tsx";
import { GoogleAiStudioProvider } from "#llm/provider/providers/googleAiStudioProvider.ts";
import { resolveAiStudioEndpoint, normalizeGoogleSdkError } from "#llm/provider/providers/googleSdkClient.ts";
import { buildGoogleContents } from "#llm/provider/providers/googleContent.ts";
import { buildAiStudioConfig } from "#llm/provider/providers/googleRequest.ts";
import { canReplayGoogleParts, invalidateGoogleReplay } from "#llm/shared/googleReplay.ts";
import { LlmProviderHttpError } from "#llm/provider/providerProtocolError.ts";
import { listProviderModelSlots } from "#llm/provider/modelListDiscovery.ts";
import { setFetchImplementationForTests } from "#services/proxy/index.ts";
import { LlmClient } from "#llm/llmClient.ts";
import { renderNativeSearchCitations } from "#llm/shared/nativeSearchCitations.ts";
import type { LlmMessage, LlmProviderRequestContext } from "#llm/provider/providerTypes.ts";

const provider = new GoogleAiStudioProvider();
const logger = pino({ level: "silent" });
const messages = [{ role: "user" as const, content: "你好" }];
function context(): LlmProviderRequestContext {
  const config = createLlmTestConfig();
  config.llm.providers.test!.type = "google";
  return { config, logger, modelRef: "main", model: "fake-model", modelProfile: config.llm.models.main!, providerName: "test", providerConfig: config.llm.providers.test!, baseUrl: "https://google.example/prefix/v1beta", candidateIndex: 0 };
}
afterEach(() => setFetchImplementationForTests(null));

for (const [raw, expected] of [
  ["https://google.example", { baseUrl: "https://google.example", apiVersion: "v1beta" }],
  ["https://google.example/prefix/v1beta/", { baseUrl: "https://google.example/prefix", apiVersion: "v1beta" }],
  ["https://google.example/prefix/v1alpha/models/foo:generateContent", { baseUrl: "https://google.example/prefix", apiVersion: "v1alpha" }],
  ["https://google.example/v1", { baseUrl: "https://google.example", apiVersion: "v1" }]
] as const) test(`SDK 端点归一化 ${raw}`, () => assert.deepEqual(resolveAiStudioEndpoint(raw), expected));

test("SDK 显式端点与模式不被宿主环境污染，禁用额外重试/超时/存储", async () => {
  const env = ["GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_GENAI_USE_ENTERPRISE", "GOOGLE_GEMINI_BASE_URL", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"];
  const previous = env.map(key => process.env[key]);
  env.forEach(key => { process.env[key] = key.includes("USE_") ? "true" : "https://bad.invalid"; });
  try {
    const ctx = context();
    await withMockFetch([{ assertRequest(body: any, _i: number, init: any, url: string) {
      assert.equal(url, "https://google.example/prefix/v1beta/models/fake-model:streamGenerateContent?alt=sse");
      const headers = new Headers(init.headers);
      assert.equal(headers.get("x-server-timeout"), null);
      assert.equal(headers.get("x-goog-api-key"), ctx.providerConfig.apiKey);
      assert.equal(body.store, false);
      assert.equal(body.generationConfig?.store, undefined);
    }, payloads: [{ candidates: [{ content: { parts: [{ text: "好" }] } }] }] }], async () => {
      assert.equal((await provider.generate(ctx, { messages })).text, "好");
    });
    const config = buildAiStudioConfig(ctx, { messages }, AbortSignal.abort());
    assert.equal(config.automaticContinuation, false);
    assert.deepEqual(config.automaticFunctionCalling, { disable: true });
  } finally { env.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }); }
});

test("SDK JSON Schema 合同与工具参数保持原约束", async () => {
  const ctx = context();
  const schema = { type: "object", properties: { additionalProperties: { type: "string" }, nested: { type: "object", additionalProperties: { type: "string" } } }, required: ["additionalProperties"], additionalProperties: false };
  const tool = createToolDefinition("lookup"); tool.function.parameters = schema;
  await withMockFetch([{ assertRequest(body: any) {
    assert.equal(body.generationConfig.responseMimeType, "application/json");
    assert.deepEqual(body.generationConfig.responseJsonSchema, schema);
    assert.deepEqual(body.tools[0].functionDeclarations[0].parametersJsonSchema, schema);
    assert.equal(body.tools[0].functionDeclarations[0].parameters, undefined);
  }, payloads: [{ candidates: [{ content: { parts: [{ text: '{}' }] } }] }] }], async () => {
    await provider.generate(ctx, { messages, tools: [tool], responseFormat: { type: "json_schema", name: "result", schema } });
  });
});

test("重复增量与尾部空文本签名按原边界保留，搜索和服务端工具不变成本地调用", async () => {
  const ctx = context();
  const parts = [{ toolCall: { id: "server", toolType: "GOOGLE_SEARCH", args: {} } }, { text: "重" }, { text: "重" }, { text: "", thoughtSignature: "tail" }];
  await withMockFetch([{ assertRequest() {}, payloads: [
    ...parts.map(part => ({ candidates: [{ content: { parts: [part] } }] })),
    { candidates: [{ finishReason: "STOP", groundingMetadata: { groundingChunks: [{ web: { uri: "https://example.org/", title: "来源" } }, { web: { uri: "https://example.org/", title: "重复" } }] } }] }
  ] }], async () => {
    const result = await provider.generate(ctx, { messages });
    assert.equal(result.text, "重重");
    assert.equal(result.toolCalls.length, 0);
    assert.deepEqual(result.assistantMetadata.googleParts, parts);
    assert.match(renderNativeSearchCitations(result.text, result.assistantMetadata), /参考来源/);
    assert.equal(result.assistantMetadata.citations.length, 1);
  });
});

test("并行调用只有首个签名即可原样回放，合成内部 ID 不冒充上游 ID", async () => {
  const ctx = context();
  const parts = [{ thoughtSignature: "sig", functionCall: { name: "lookup", args: {} } }, { functionCall: { name: "lookup", args: {} } }];
  assert.equal(canReplayGoogleParts(parts), true);
  assert.equal(canReplayGoogleParts([{ functionCall: { name: "lookup" } }, parts[0]]), false);
  await withMockFetch([{ assertRequest() {}, payloads: [{ candidates: [{ content: { parts } }] }] }], async () => {
    const result = await provider.generate(ctx, { messages });
    assert.notEqual(result.toolCalls[0]!.id, result.toolCalls[1]!.id);
    const history: LlmMessage[] = [...messages, { role: "assistant" as const, content: "", tool_calls: result.toolCalls, providerMetadata: result.assistantMetadata }, ...result.toolCalls.map(call => ({ role: "tool" as const, tool_call_id: call.id, content: '{"ok":true}' }))];
    const replay = buildGoogleContents(ctx, history);
    assert.deepEqual(replay[1]!.parts, parts);
    assert.equal(replay[2]!.parts![0]!.functionResponse!.id, undefined);
    assert.deepEqual(replay[2]!.parts![0]!.functionResponse!.response, { ok: true });
    const other = buildGoogleContents({ ...ctx, model: "other-model" }, history);
    assert.match(other[1]!.parts![0]!.text!, /历史工具调用/);
    assert.match(other[2]!.parts![0]!.text!, /历史工具结果/);
    assert.equal(JSON.stringify(other).includes('thoughtSignature'), false);
    history[1]!.providerMetadata = invalidateGoogleReplay(result.assistantMetadata)!;
    assert.equal(JSON.stringify(buildGoogleContents(ctx, history)).includes('thoughtSignature'), false);
  });
});

for (const reason of [undefined, "MAX_TOKENS", "MALFORMED_FUNCTION_CALL", "CONTINUATION", "SAFETY"]) test(`异常终态 ${reason} 不执行工具`, async () => {
  const ctx = context(); let executed = 0;
  const payload = { candidates: [{ content: { parts: [{ functionCall: { name: "lookup", args: {} } }] }, ...(reason ? { finishReason: reason } : {}) }] };
  await withMockFetch([{ assertRequest() {}, response: new Response(`data: ${JSON.stringify(payload)}\n\n`, { headers: { "content-type": "text/event-stream" } }) }], async () => {
    await assert.rejects(new LlmClient(ctx.config, logger).generate({ messages, tools: [createToolDefinition("lookup")], toolExecutor: async () => { executed++; return "{}"; } }));
  });
  assert.equal(executed, 0);
});

for (const status of [400, 429, 503]) test(`ApiError ${status} 保留公共 HTTP 状态与 cause`, async () => {
  const error = new ApiError({ status, message: "test" });
  const normalized = normalizeGoogleSdkError(error);
  assert.ok(normalized instanceof LlmProviderHttpError); assert.equal(normalized.statusCode, status); assert.equal(normalized.cause, error);
  await withMockFetch([{ assertRequest() {}, payloads: [{ error: { code: status, message: "test", status: "TEST_ERROR" } }] }], async () => {
    await assert.rejects(provider.generate(context(), { messages }), err => err instanceof LlmProviderHttpError && err.statusCode === status);
  });
});

test("不规范字符串错误不被 SDK 解码成功伪装为成功", async () => {
  await withMockFetch([{ assertRequest() {}, payloads: [{ error: { code: "invalid_request", message: "bad" } }] }], async () => {
    await assert.rejects(provider.generate(context(), { messages }), /未正常完成/);
  });
});

test("中途协议错误取消所属响应体，预取消不发请求，正常结束不 abort", async () => {
  let cancelled = false; let signal: AbortSignal | undefined;
  setFetchImplementationForTests(async (_url, init) => {
    signal = init?.signal as AbortSignal;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/png","data":"large"}}]}}]}\n\n')); }, cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } });
  });
  await assert.rejects(provider.generate(context(), { messages }), /不支持媒体输出/);
  assert.equal(cancelled, true); assert.equal(signal?.aborted, true);
  let calls = 0; setFetchImplementationForTests(async () => { calls++; throw new Error("unexpected"); });
  const original = new Error("用户取消");
  await assert.rejects(provider.generate(context(), { messages, abortSignal: AbortSignal.abort(original) }), error => error === original);
  assert.equal(calls, 0);
  await withMockFetch([{ assertRequest(_body: any, _i: number, init: any) { signal = init.signal; }, payloads: [{ candidates: [{ content: { parts: [{ text: "好" }] } }] }] }], async () => { await provider.generate(context(), { messages }); });
  assert.equal(signal?.aborted, false);
});

test("思考控制显式配置，无模型名称推断；额外参数不得覆盖协议", () => {
  const ctx = context(); const chat = ctx.modelProfile.chat!;
  chat.googleThinking = { mode: "budget", budget: 2048 };
  const request = buildAiStudioConfig(ctx, { messages, enableThinkingOverride: false }, new AbortController().signal);
  assert.deepEqual(request.thinkingConfig, { includeThoughts: false, thinkingBudget: 0 });
  chat.capabilities.thinkingControllable = false; chat.googleThinking = { mode: "level", level: "HIGH" };
  assert.deepEqual(buildAiStudioConfig(ctx, { messages, enableThinkingOverride: false }, new AbortController().signal).thinkingConfig, { includeThoughts: false, thinkingLevel: "HIGH" });
  chat.defaults.extra = { httpOptions: { timeout: 1 } };
  assert.throws(() => buildAiStudioConfig(ctx, { messages }, new AbortController().signal), /httpOptions/);
});

test("SDK 清单公开分页与 supportedActions 正确归一，Live 不伪装聊天", async () => {
  const ctx = context(); let requests = 0;
  setFetchImplementationForTests(async (url, init) => {
    if (url.startsWith("https://models.dev/")) return Response.json({ google: { models: { text: { name: "Text" } } } });
    requests++; assert.ok(init?.dispatcher); assert.match(url, /\/prefix\/v1beta\/models\?/);
    assert.equal(new Headers(init?.headers as HeadersInit).get("x-goog-api-key"), ctx.providerConfig.apiKey);
    const payload = requests === 1 ? { models: [{ name: "models/text", thinking: true, inputTokenLimit: 100, supportedGenerationMethods: ["generateContent"] }], nextPageToken: "page2" }
      : { models: [{ name: "models/vector", supportedGenerationMethods: ["embedContent"] }, { name: "models/live", supportedGenerationMethods: ["bidiGenerateContent"] }] };
    return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
  });
  const result = await listProviderModelSlots({ config: ctx.config, provider: llmCatalogFileSchema.parse({ test: { type: "google", apiKey: "test-key", proxy: false, baseUrl: ctx.baseUrl, models: {} } }).test! });
  assert.equal(requests, 2); assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal((result.models[0]!.profile.chat as any).capabilities.supportsThinking, true);
  assert.equal((result.models[0]!.profile.chat as any).capabilities.supportsTools, undefined);
  assert.ok(result.models[1]!.profile.embedding); assert.equal(result.models[2]!.profile.chat, undefined);
});

test("SDK 清单重复分页最多请求 50 页", async () => {
  const ctx = context(); let requests = 0;
  setFetchImplementationForTests(async () => { requests++; return new Response(JSON.stringify({ models: [], nextPageToken: "loop" }), { headers: { "content-type": "application/json" } }); });
  await assert.rejects(listProviderModelSlots({ config: ctx.config, provider: llmCatalogFileSchema.parse({ test: { type: "google", apiKey: "test-key", proxy: false, baseUrl: ctx.baseUrl, models: {} } }).test! }), /50 页/);
  assert.equal(requests, 50);
});

test("省略 args 的无参数函数调用合法，半成品参数拒绝执行", async () => {
  for (const call of [{ name: "lookup" }, { name: "lookup", willContinue: true, args: {} }]) {
    await withMockFetch([{ assertRequest() {}, payloads: [{ candidates: [{ content: { parts: [{ functionCall: call }] } }] }] }], async () => {
      if ("willContinue" in call) await assert.rejects(provider.generate(context(), { messages }), /未完成/);
      else assert.equal((await provider.generate(context(), { messages })).toolCalls[0]?.function.arguments, "{}");
    });
  }
});

test("429/503 只走项目候选 fallback，不产生 SDK 内部重试", async () => {
  for (const status of [429, 503]) {
    const ctx = context();
    const fallback = structuredClone(ctx.modelProfile); fallback.model = "fallback-model";
    ctx.config.llm.models.fallback = fallback;
    let calls = 0;
    await withMockFetch([
      { assertRequest() { calls++; }, response: new Response(JSON.stringify({ error: { code: status, message: "busy" } }), { status, headers: { "content-type": "application/json" } }) },
      { assertRequest(_body: any, _index: number, _init: unknown, url: string) { calls++; assert.match(url, /fallback-model/); }, payloads: [{ candidates: [{ content: { parts: [{ text: "备用成功" }] } }] }] }
    ], async () => { assert.equal((await new LlmClient(ctx.config, logger).generate({ modelRefOverride: ["main", "fallback"], messages, skipDebugDump: true })).text, "备用成功"); });
    assert.equal(calls, 2);
  }
});

test("服务端工具首包结束首响应等待，空文本不算首包", async () => {
  for (const meaningful of [true, false]) {
    const ctx = context(); ctx.config.llm.firstTokenTimeoutMs = 20; ctx.config.llm.timeoutMs = 1000;
    setFetchImplementationForTests(async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const emit = (value: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
        emit({ candidates: [{ content: { parts: [meaningful ? { toolCall: { id: "server", toolType: "GOOGLE_SEARCH", args: {} } } : { text: "" }] } }] });
        const timer = setTimeout(() => { emit({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "完成" }] } }] }); controller.close(); }, 60);
        init?.signal?.addEventListener("abort", () => { clearTimeout(timer); controller.error(init.signal?.reason); }, { once: true });
      }
    }), { headers: { "content-type": "text/event-stream" } }));
    if (meaningful) assert.equal((await provider.generate(ctx, { messages })).text, "完成");
    else await assert.rejects(provider.generate(ctx, { messages }), /first token timeout/);
  }
});

test("Google 能力探测保留状态码分类并为隐藏推理留预算", async () => {
  const { ModelCapabilityProbe } = await import("#llm/provider/modelCapabilityProbe.ts");
  const ctx = context();
  await withMockFetch([{ assertRequest(body: any) { assert.equal(body.generationConfig.maxOutputTokens, 1024); }, response: new Response(JSON.stringify({ error: { code: 400, message: "invalid" } }), { status: 400, headers: { "content-type": "application/json" } }) }], async () => {
    const result = await new ModelCapabilityProbe(ctx.config).run({ provider: { type: "google", apiKey: "synthetic-key", proxy: false }, model: { upstreamModel: "fake", chat: { capabilities: { supportsThinking: true, thinkingControllable: false } } }, operation: "chat" });
    assert.equal(result.status, "inconclusive"); assert.match(result.message, /400/);
  });
});

test("SDK 模型清单整体取消与超时覆盖分页请求", async () => {
  const ctx = context(); const provider = llmCatalogFileSchema.parse({ test: { type: "google", apiKey: "synthetic-key", proxy: false, models: {} } }).test!;
  const controller = new AbortController();
  let calls = 0;
  let reached!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; });
  setFetchImplementationForTests(async (_url, init) => { calls++; return new Promise((_resolve, reject) => { init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }); reached(); }); });
  const running = listProviderModelSlots({ config: ctx.config, provider, abortSignal: controller.signal });
  await started;
  controller.abort(new Error("清单取消"));
  await assert.rejects(running, /清单取消/); assert.equal(calls, 1);
});
