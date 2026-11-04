import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { LlmClient } from "../../../src/llm/llmClient.ts";
import { createTestAppConfig } from "../../helpers/config-fixtures.tsx";
import { createSseResponse } from "../../helpers/llm-test-support.tsx";
import { setFetchImplementationForTests } from "../../../src/services/proxy/index.ts";

afterEach(() => setFetchImplementationForTests(null));
const questions = [{ name: "condition", type: "predicate" as const, instructions: "是否满足条件？" }];
const audio = { data: Buffer.from("audio").toString("base64"), format: "wav" };
function setup() {
  const config = createTestAppConfig({ llm: {
    enabled: true, routingPreset: "test",
    providers: { official: { type: "openai", apiKey: "test-only", baseUrl: "https://native.example/v1" } },
    models: {
      first: { provider: "official", model: "first-model", transcription: {}, speech: {}, decision: {} },
      second: { provider: "official", model: "second-model", transcription: {}, speech: {}, decision: {} }
    },
    routingPresets: { test: { audioTranscription: ["first", "second"], speechGenerator: ["first", "second"], decision: ["first", "second"] } }
  } });
  return { config, client: new LlmClient(config, pino({ level: "silent" })) };
}

test("原生能力可用性按模型用途、供应商实现和全局开关过滤", () => {
  const { config, client } = setup();
  config.llm.models.chat_only = { provider: "official", model: "chat-only", chat: config.llm.models.main!.chat! };
  for (const operation of ["transcription", "speech", "decision"] as const) {
    assert.equal(client.isCapabilityConfigured(operation), true);
    assert.equal(client.isCapabilityConfigured(operation, ["missing", "chat_only"]), false);
    assert.equal(client.isCapabilityConfigured(operation, ["chat_only", "second"]), true);
  }
  config.llm.providers.official!.type = "openai_compatible";
  assert.equal(client.isCapabilityConfigured("transcription", "first"), true);
  assert.equal(client.isCapabilityConfigured("speech", "first"), false);
  assert.equal(client.isCapabilityConfigured("decision", "first"), false);
  config.llm.enabled = false;
  for (const operation of ["transcription", "speech", "decision"] as const) assert.equal(client.isCapabilityConfigured(operation, "first"), false);
});

for (const operation of ["transcription", "decision"] as const) {
  for (const status of [429, 503]) {
    test(`${operation} HTTP ${status} 按配置顺序 fallback 到下一原生模型`, async () => {
      const { client } = setup();
      const models: unknown[] = [];
      setFetchImplementationForTests(async (url, init) => {
        assert.equal(url, `https://native.example/v1/${operation === "transcription" ? "audio/transcriptions" : "decisions"}`);
        const model = operation === "transcription" ? (init!.body as FormData).get("model") : JSON.parse(String(init?.body)).model;
        models.push(model);
        if (models.length === 1) return new Response("upstream rejected", { status });
        return operation === "transcription" ? Response.json({ text: "成功转写" }) : Response.json({ answers: [{ name: "condition", type: "predicate", probability: 0.7 }] });
      });
      const result = operation === "transcription" ? await client.transcribe({ audio, skipDebugDump: true }) : await client.decide({ input: "证据", questions, skipDebugDump: true });
      assert.deepEqual(models, ["first-model", "second-model"]);
      assert.equal(result.usage.modelRef, "second");
    });
  }

  test(`${operation} 调用方取消时不 fallback`, async () => {
    const { client } = setup();
    const controller = new AbortController();
    const reason = new Error("用户取消");
    let calls = 0;
    setFetchImplementationForTests(async (_url, init) => {
      calls++;
      controller.abort(reason);
      throw init!.signal!.reason;
    });
    const params = { abortSignal: controller.signal, skipDebugDump: true };
    await assert.rejects(operation === "transcription" ? client.transcribe({ audio, ...params }) : client.decide({ input: "证据", questions, ...params }), error => error === reason);
    assert.equal(calls, 1);
  });

  test(`${operation} 无效请求不 fallback`, async () => {
    const { client } = setup();
    let calls = 0;
    setFetchImplementationForTests(async () => { calls++; return new Response("invalid configuration", { status: 400 }); });
    await assert.rejects(operation === "transcription" ? client.transcribe({ audio, skipDebugDump: true }) : client.decide({ input: "证据", questions, skipDebugDump: true }), /HTTP 400/);
    assert.equal(calls, 1);
  });
}

test("synthesize 上游失败时不重试也不切换模型以避免重复计费", async () => {
  const { client } = setup();
  let calls = 0;
  setFetchImplementationForTests(async (_url, init) => {
    calls++;
    assert.equal(JSON.parse(String(init?.body)).model, "first-model");
    return new Response("temporarily unavailable", { status: 503 });
  });
  await assert.rejects(client.synthesize({ text: "你好", skipDebugDump: true }), /HTTP 503/);
  assert.equal(calls, 1);
});

for (const thinking of [true, false]) {
  test(`兼容转写保留既有 audioTranscription.enableThinking=${thinking}`, async () => {
    const { config } = setup();
    config.llm.providers.official!.type = "openai_compatible";
    config.llm.providers.official!.features = { thinking: { type: "flag", path: "enable_thinking" } };
    config.llm.audioTranscription.enableThinking = thinking;
    const profile = config.llm.models.first!;
    profile.transcription!.capabilities = { supportsAudioInput: true, supportsThinking: true, thinkingControllable: true };
    let calls = 0;
    setFetchImplementationForTests(async (url, init) => {
      calls++;
      assert.equal(url, "https://native.example/v1/chat/completions");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.enable_thinking, thinking);
      assert.equal(body.messages[0].role, "system");
      assert.match(body.messages[0].content, /不总结/);
      assert.deepEqual(body.messages[1].content[1].input_audio, audio);
      return createSseResponse([{ choices: [{ delta: { content: "转写结果" }, finish_reason: "stop" }] }]);
    });
    const result = await new LlmClient(config, pino({ level: "silent" })).transcribe({ audio, skipDebugDump: true });
    assert.equal(result.text, "转写结果");
    assert.equal(calls, 1);
  });
}
