import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { createTestAppConfig } from "../../helpers/config-fixtures.tsx";
import { setFetchImplementationForTests } from "../../../src/services/proxy/index.ts";
import { requestOpenAiTranscription, requestOpenAiSpeech } from "../../../src/llm/provider/openAiNativeAudio.ts";
import { requestOpenAiDecision } from "../../../src/llm/provider/openAiNativeDecision.ts";
import type { LlmProviderRequestContext } from "../../../src/llm/provider/providerTypes.ts";
import type { DecisionQuestion } from "../../../src/llm/provider/nativeCapabilityTypes.ts";

afterEach(() => setFetchImplementationForTests(null));
function context(): LlmProviderRequestContext {
  const config = createTestAppConfig({ llm: { enabled: true, providers: { official: { type: "openai", apiKey: "test-key", baseUrl: "https://official.example/v1/" } }, models: { native: { provider: "official", model: "native-test", transcription: { language: "zh", prompt: "保留人名。" }, speech: { voice: "coral", format: "mp3", speed: 1 }, decision: {} } } } });
  return { config, logger: pino({ level: "silent" }), modelRef: "native", model: "native-test", modelProfile: config.llm.models.native!, providerName: "official", providerConfig: config.llm.providers.official!, baseUrl: "https://official.example/v1/", candidateIndex: 0 };
}

test("官方转写上传真实文件并使用原生参数，保留 token 用量", async () => {
  setFetchImplementationForTests(async (url, init) => {
    assert.equal(url, "https://official.example/v1/audio/transcriptions");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-key");
    assert.equal((init?.headers as Record<string, string>)["Content-Type"], undefined);
    const form = init!.body as FormData;
    assert.equal(form.get("model"), "native-test");
    assert.equal(form.get("language"), "zh");
    assert.equal(form.get("prompt"), "保留人名。");
    assert.equal(form.get("response_format"), "json");
    const file = form.get("file") as File;
    assert.equal(file.name, "audio.wav");
    assert.equal(await file.text(), "audio-bytes");
    return Response.json({ text: "原始转写", usage: { type: "tokens", input_tokens: 4, output_tokens: 3, total_tokens: 7 } });
  });
  const result = await requestOpenAiTranscription(context(), { audio: { data: Buffer.from("audio-bytes").toString("base64"), format: "wav", mimeType: "audio/wav" } });
  assert.equal(result.text, "原始转写");
  assert.equal(result.usage.totalTokens, 7);
  assert.equal(result.usage.modelRef, "native");
});

test("非法转写文件和预先取消在发送前失败", async () => {
  let calls = 0;
  setFetchImplementationForTests(async () => { calls++; throw new Error("不应调用"); });
  for (const audio of [{ data: "bad", format: "wav" }, { data: "YQ==", format: "silk" }]) {
    await assert.rejects(requestOpenAiTranscription(context(), { audio }));
  }
  await assert.rejects(requestOpenAiTranscription(context(), { audio: { data: "YQ==", format: "wav" }, abortSignal: AbortSignal.abort() }), /abort/i);
  assert.equal(calls, 0);
});

test("语音请求隔离聊天参数，原样返回音频且不伪造 token 用量", async () => {
  setFetchImplementationForTests(async (url, init) => {
    assert.equal(url, "https://official.example/v1/audio/speech");
    assert.deepEqual(JSON.parse(String(init?.body)), { model: "native-test", input: "你好", voice: "coral", response_format: "mp3", speed: 1, instructions: "自然朗读。" });
    return new Response(new Uint8Array([73, 68, 51, 0]), { headers: { "content-type": "audio/mpeg" } });
  });
  const result = await requestOpenAiSpeech(context(), { text: "你好", instructions: "自然朗读。" });
  assert.equal(result.mimeType, "audio/mpeg");
  assert.equal(result.extension, "mp3");
  assert.equal(result.buffer.length, 4);
  assert.equal(result.usage.requestCount, 1);
  assert.equal(result.usage.inputTokens, null);
  assert.equal(result.usage.providerReported, false);
});

test("语音失败、非音频和超限响应不重试，输出大小按实际流限制", async () => {
  for (const response of [new Response("failed", { status: 503 }), Response.json({ error: "bad" }), new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } })]) {
    let calls = 0;
    const ctx = context();
    ctx.config.chatFiles.maxUploadBytes = 2;
    setFetchImplementationForTests(async () => { calls++; return response; });
    await assert.rejects(requestOpenAiSpeech(ctx, { text: "你好" }));
    assert.equal(calls, 1);
  }
});

const questions: DecisionQuestion[] = [
  { name: "condition", type: "predicate", instructions: "是否满足条件？" },
  { name: "category", type: "choice", instructions: "选择类别。", choices: [{ value: "A" }, { value: "B" }] },
  { name: "rating", type: "score", instructions: "评估严重程度。", levels: [{ label: "低" }, { label: "高" }] },
  { name: "refused", type: "predicate", instructions: "能否判断？" }
];
const answers = [
  { name: "condition", type: "predicate", probability: 0.8 },
  { name: "category", type: "choice", choice: "B", confidence: 0.6, probabilities: [{ value: "A", probability: 0.2 }, { value: "B", probability: 0.8 }] },
  { name: "rating", type: "score", score: 0.75, confidence: 0.5, probabilities: [{ value: 0, label: "低", probability: 0.25 }, { value: 1, label: "高", probability: 0.75 }] },
  { name: "refused", type: "refusal" }
];

test("Decisions 原生接收 JSON 证据、三类答案和局部拒绝", async () => {
  const input = [{ role: "user" as const, content: [{ type: "input_json" as const, data: { evidence: 1 } }] }];
  setFetchImplementationForTests(async (url, init) => {
    assert.equal(url, "https://official.example/v1/decisions");
    assert.deepEqual(JSON.parse(String(init?.body)), { model: "native-test", input, questions });
    return Response.json({ answers, usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10, input_tokens_details: { cached_tokens: 5 } } });
  });
  const result = await requestOpenAiDecision(context(), { input, questions });
  assert.deepEqual(result.answers, answers);
  assert.equal(result.usage.cachedTokens, 5);
  assert.equal(result.usage.outputTokens, 0);
});

test("Decisions 验证问题和返回契约，不将缺失或错误结果当成否定", async () => {
  let calls = 0;
  setFetchImplementationForTests(async () => { calls++; return Response.json({ answers }); });
  await assert.rejects(requestOpenAiDecision(context(), { input: "证据", questions: [questions[0]!, questions[0]!] }), /唯一/);
  assert.equal(calls, 0);
  for (const invalid of [[], [{ name: "wrong", type: "predicate", probability: 0.5 }], [{ name: "condition", type: "predicate", probability: -1 }]]) {
    setFetchImplementationForTests(async () => Response.json({ answers: invalid }));
    await assert.rejects(requestOpenAiDecision(context(), { input: "证据", questions: [questions[0]!] }));
  }
});

test("原生请求超时中止传输且不重试", async () => {
  let calls = 0;
  setFetchImplementationForTests(async (_url, init) => {
    calls++;
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    });
  });
  const promise = requestOpenAiDecision(context(), { input: "证据", questions: [questions[0]!], timeoutMsOverride: 5 });
  const keepAlive = setTimeout(() => {}, 100);
  try { await assert.rejects(promise, /timeout/i); } finally { clearTimeout(keepAlive); }
  assert.equal(calls, 1);
});
