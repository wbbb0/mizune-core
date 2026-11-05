import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { LlmClient } from "#llm/llmClient.ts";
import { LlmProviderHttpError } from "#llm/provider/providerProtocolError.ts";
import { setFetchImplementationForTests } from "#services/proxy/index.ts";
import { createTestAppConfig } from "../../helpers/config-fixtures.tsx";
import { ContextEmbeddingService } from "#context/contextEmbeddingService.ts";

function config(inputMode: "plain" | "task_type" | "task_prefix" = "plain", model = "gemini-embedding-2") {
  return createTestAppConfig({ llm: { enabled: true, providers: { test: { type: "google", baseUrl: "https://google.example/prefix/v1beta", apiKey: "synthetic-key", proxy: false } }, models: { "test/embedding": { provider: "test", model, embedding: { dimensions: 2, inputMode, queryPrefix: "查询：", documentPrefix: "文档：" } } } } });
}
const logger = pino({ level: "silent" });
afterEach(() => setFetchImplementationForTests(null));

for (const mode of ["plain", "task_type", "task_prefix"] as const) for (const purpose of ["query", "document"] as const) {
  test(`Google 向量 ${mode}/${purpose} 每条输入独立且按显式模式组装`, async () => {
    const c = config(mode);
    let calls = 0;
    setFetchImplementationForTests(async (url, init) => {
      calls++;
      assert.equal(url, "https://google.example/prefix/v1beta/models/gemini-embedding-2:batchEmbedContents");
      assert.equal(new Headers(init?.headers as HeadersInit).get("x-goog-api-key"), "synthetic-key");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.requests.length, 2);
      const prefix = mode === "task_prefix" ? (purpose === "query" ? "查询：" : "文档：") : "";
      assert.deepEqual(body.requests.map((request: any) => request.content.parts[0].text), [`${prefix}甲`, `${prefix}乙`]);
      for (const request of body.requests) {
        assert.equal(request.outputDimensionality, 2);
        assert.equal(request.taskType, mode === "task_type" ? purpose === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT" : undefined);
        assert.equal(request.store, undefined); assert.equal(request.thinkingConfig, undefined);
      }
      return Response.json({ embeddings: [{ values: [3, 4] }, { values: [0, -9] }] });
    });
    const result = await new LlmClient(c, logger).embedTexts({ texts: ["甲", "乙"], purpose });
    assert.deepEqual(result.vectors, [[0.6, 0.8], [0, -1]]); assert.equal(calls, 1);
    assert.equal(result.usage.requestCount, 1); assert.equal(result.usage.providerReported, false);
  });
}

for (const embeddings of [[], [{ values: [1, 2] }], [{ values: [] }, { values: [1, 2] }], [{ values: [1, null] }, { values: [1, 2] }], [{ values: [0, 0] }, { values: [1, 2] }], [{ values: [1, 2, 3] }, { values: [1, 2] }]]) {
  test(`Google 向量拒绝数量/维度/数值损坏 ${JSON.stringify(embeddings)}`, async () => {
    setFetchImplementationForTests(async () => Response.json({ embeddings }));
    await assert.rejects(new LlmClient(config(), logger).embedTexts({ texts: ["甲", "乙"] }));
  });
}

test("Google 向量取消、超时和 HTTP 状态保留且不重试", async () => {
  let calls = 0;
  setFetchImplementationForTests(async () => { calls++; return Response.json({ error: { code: 429, message: "quota" } }, { status: 429 }); });
  await assert.rejects(new LlmClient(config(), logger).embedTexts({ texts: ["甲"] }), error => error instanceof LlmProviderHttpError && error.statusCode === 429);
  assert.equal(calls, 1);
  const cancellation = new Error("用户取消向量请求");
  await assert.rejects(new LlmClient(config(), logger).embedTexts({ texts: ["甲"], abortSignal: AbortSignal.abort(cancellation) }), error => error === cancellation);
  assert.equal(calls, 1);
  setFetchImplementationForTests(async (_url, init) => new Promise((_resolve, reject) => { init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }); }));
  await assert.rejects(new LlmClient(config(), logger).embedTexts({ texts: ["甲"], timeoutMsOverride: 10 }), /timeout/);
});

test("Google 向量原始响应有界并取消超限正文", async () => {
  let cancelled = false;
  setFetchImplementationForTests(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(32 * 1024 * 1024 + 1)); }, cancel() { cancelled = true; } }), { headers: { "content-type": "application/json" } }));
  await assert.rejects(new LlmClient(config(), logger).embedTexts({ texts: ["甲"] }), /超过大小限制/);
  assert.equal(cancelled, true);
});

test("Google 向量前缀改变时 profile 失效，查询与文档仍共享同一空间", async () => {
  const c = config("task_prefix");
  setFetchImplementationForTests(async () => Response.json({ embeddings: [{ values: [3, 4] }] }));
  const service = new ContextEmbeddingService(c, new LlmClient(c, logger), logger);
  const first = await service.embedTexts(["甲"], { purpose: "document" });
  const query = await service.embedTexts(["甲"], { purpose: "query" });
  assert.equal(first.profile.profileId, query.profile.profileId);
  c.llm.models["test/embedding"]!.embedding!.documentPrefix = "新文档：";
  const changed = await service.embedTexts(["甲"]);
  assert.notEqual(first.profile.profileId, changed.profile.profileId);
});
