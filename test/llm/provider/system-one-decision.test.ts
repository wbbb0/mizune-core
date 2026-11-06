import test from "node:test";
import assert from "node:assert/strict";
import { systemOneEndpoint } from "../../../src/llm/provider/decision/systemOne.ts";
import { encodeSystemOne, decodeSystemOne } from "../../../src/llm/provider/decision/systemOneCodec.ts";
import { supportsProviderDecision } from "../../../src/llm/provider/providerRegistry.ts";
import type { LlmDecideParams } from "../../../src/llm/provider/nativeCapabilityTypes.ts";
const params: LlmDecideParams = { input: "公开测试", questions: [
  { name: "predicate", type: "predicate", instructions: "是否测试" },
  { name: "choice", type: "choice", instructions: "选择", choices: [{ value: true }, { value: "true" }] },
  { name: "score", type: "score", instructions: "评分", levels: [{ label: "低" }, { label: "高" }] }
] };
test("System One preserves typed options, question order and zero-based score levels", () => {
  assert.deepEqual(Object.keys(encodeSystemOne(params).questions), ["q0", "q1", "q2"]);
  const answers = decodeSystemOne({ q2: { type: "score", score: .8, probabilities: { "0": .2, "1": .8 }, confidence: .8 }, q1: { type: "choice", choice: "c1", confidence: .9, probabilities: { c0: .1, c1: .9 } }, q0: { type: "noul", noul: .95 } }, params);
  assert.equal(answers[1]!.type, "choice");
  assert.equal(answers[1]!.type === "choice" && answers[1]!.choice, "true");
  assert.equal(answers[2]!.type === "score" && answers[2]!.score, .8);
});
test("System One rejects incomplete or invalid distributions and unsupported media", () => {
  assert.throws(() => decodeSystemOne({}, params));
  assert.throws(() => decodeSystemOne({ q0: { type: "noul", noul: 2 }, q1: {}, q2: {} }, params));
  assert.throws(() => encodeSystemOne({ ...params, input: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.invalid/image.png" }] }] }));
});
test("decision endpoint mapping preserves gateway prefixes", () => {
  assert.equal(systemOneEndpoint("https://gateway.invalid/prefix/api/v1/", "openrouter").href, "https://gateway.invalid/prefix/api/alpha/decisions");
  assert.equal(systemOneEndpoint("https://dashscope.aliyuncs.com/api/v1", "dashscope").href, "https://dashscope.aliyuncs.com/compatible-mode/v1/systemone");
});
test("decision support is explicit for each provider", () => {
  for (const type of ["openai", "openai_compatible", "openai_responses_compatible", "openrouter", "dashscope", "lmstudio"]) assert.equal(supportsProviderDecision(type), true, type);
  for (const type of ["deepseek", "anthropic", "google", "vertex", "vertex_express"]) assert.equal(supportsProviderDecision(type), false, type);
});

test("System One rejects absent confidence rather than inventing certainty", () => {
  const choice = { input: "test", questions: [params.questions[1]!] };
  assert.throws(() => decodeSystemOne({ q0: { type: "choice", choice: "c0", probabilities: { c0: .9, c1: .1 } } }, choice));
});

test("configured capability directory agrees with actual provider implementations", async () => {
  const { llmProviderTypes, supportsNativeDecision } = await import("../../../src/config/llmProviderDefinitions.ts");
  for (const type of llmProviderTypes) assert.equal(supportsNativeDecision(type), supportsProviderDecision(type), type);
});

test("model discovery identifies explicit decision metadata without chat inference", async () => {
  const { parseDiscoveredModels } = await import("../../../src/llm/provider/modelDiscoveryMetadata.ts");
  const found = parseDiscoveredModels({ data: [{ id: "decision-model", type: "decision" }, { id: "remote", architecture: { output_modalities: ["decision"] } }] }, "test", "chat");
  for (const model of found) { assert.deepEqual(model.profile.decision, {}); assert.equal(model.profile.chat, undefined); }
});

test("OpenRouter SDK uses configured gateway and preserves HTTP errors without SDK retries", async () => {
  const { createTestAppConfig } = await import("../../helpers/config-fixtures.tsx");
  const { setFetchImplementationForTests } = await import("../../../src/services/proxy/index.ts");
  const { requestSystemOne } = await import("../../../src/llm/provider/decision/systemOne.ts");
  const { LlmProviderHttpError } = await import("../../../src/llm/provider/providerProtocolError.ts");
  const { default: pino } = await import("pino");
  const config = createTestAppConfig({ llm: { providers: { router: { type: "openrouter", apiKey: "test" } } } });
  const context = { config, logger: pino({ level: "silent" }), modelRef: "test", model: "test", modelProfile: { provider: "router", model: "test", decision: {} }, providerName: "router", providerConfig: config.llm.providers.router!, baseUrl: "https://gateway.invalid/proxy/api/v1", candidateIndex: 0 };
  let calls = 0;
  setFetchImplementationForTests(async (url, init) => {
    calls++;
    assert.equal(url, "https://gateway.invalid/proxy/api/alpha/decisions");
    assert.equal(JSON.parse(String(init?.body)).questions.q0.type, "noul");
    return new Response("x".repeat(100_000), { status: 429 });
  });
  try {
    await assert.rejects(requestSystemOne(context, { input: "test", questions: [params.questions[0]!] }), (error: unknown) => error instanceof LlmProviderHttpError && error.statusCode === 429);
    assert.equal(calls, 1);
    setFetchImplementationForTests(async () => Response.json({ model: "test", answers: { q0: { type: "noul", noul: .9 } }, usage: {} }));
    await assert.rejects(requestSystemOne(context, { input: "test", questions: [params.questions[0]!] }), (error: unknown) => error instanceof Error && !(error instanceof LlmProviderHttpError) && error.name === "ResponseValidationError");
  } finally { setFetchImplementationForTests(null); }
});
