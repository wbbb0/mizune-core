import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { ModelCapabilityProbe, ModelCapabilityProbeBusyError, type ModelCapabilityProbeInput } from "#llm/provider/modelCapabilityProbe.ts";
import { setFetchImplementationForTests } from "#services/proxy/index.ts";
import { createTestAppConfig } from "../../helpers/config-fixtures.tsx";
import { createSseResponse } from "../../helpers/llm-test-support.tsx";

afterEach(() => setFetchImplementationForTests(null));
const draft = { type: "openai_compatible", baseUrl: "https://draft.example/v1", apiKey: "draft-secret", proxy: false };
function input(operation: ModelCapabilityProbeInput["operation"], extra: Partial<ModelCapabilityProbeInput> = {}): ModelCapabilityProbeInput {
  return { provider: draft, model: { upstreamModel: "unregistered-model" }, operation, ...extra };
}
function chat(text = "好") { return createSseResponse([{ choices: [{ delta: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } }]); }

test("probe uses unsaved draft credentials and single low-budget adapter call without changing configuration", async () => {
  const config = createTestAppConfig();
  config.llm.enabled = false;
  const before = structuredClone(config);
  let calls = 0;
  setFetchImplementationForTests(async (url, init) => {
    calls++;
    assert.equal(url, "https://draft.example/v1/chat/completions");
    assert.equal((init!.headers as Record<string, string>).Authorization, "Bearer draft-secret");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "unregistered-model");
    assert.equal(body.max_tokens, 32);
    assert.equal(body.enable_thinking, false);
    assert.equal(body.temperature, undefined);
    assert.equal(body.tools, undefined);
    assert.equal(body.enable_search, undefined);
    return chat();
  });
  const probe = new ModelCapabilityProbe(config);
  const result = await probe.run(input("chat", { provider: { ...draft, models: { unrelated: "bad draft" }, features: { thinking: { type: "flag", path: "enable_thinking" }, search: { type: "flag", path: "enable_search" } } }, model: {
    upstreamModel: "unregistered-model", chat: { capabilities: { supportsThinking: true, thinkingControllable: true, supportsSearch: true }, searchEnabled: true, defaults: { maxOutputTokens: 100000, temperature: 2, extra: { tools: [{ type: "web_search" }] } } }
  } }));
  assert.equal(result.status, "passed");
  assert.equal(result.usage?.totalTokens, 5);
  assert.equal(calls, 1);
  assert.deepEqual(config, before);
});

test("embedding operation is testable without a configured operation and validates actual vector data", async () => {
  const probe = new ModelCapabilityProbe(createTestAppConfig());
  for (const vectors of [[[0.1, 0.2]], [[]]]) {
    let calls = 0;
    setFetchImplementationForTests(async (url, init) => {
      calls++;
      assert.equal(url, "https://draft.example/v1/embeddings");
      const body = JSON.parse(String(init!.body));
      assert.deepEqual(body.input, ["你好"]);
      assert.equal(body.dimensions, undefined);
      return Response.json({ data: vectors.map((embedding, index) => ({ index, embedding })) });
    });
    const result = await probe.run(input("embedding"));
    assert.equal(result.status, vectors[0]!.length ? "passed" : "inconclusive");
    assert.equal(calls, 1);
  }
});

test("local unsupported capabilities do not send requests or falsely label the upstream model", async () => {
  let calls = 0;
  setFetchImplementationForTests(async () => { calls++; throw new Error("unexpected"); });
  const probe = new ModelCapabilityProbe(createTestAppConfig());
  for (const operation of ["speech", "decision"] as const) {
    const result = await probe.run(input(operation, { provider: { ...draft, type: "anthropic" } }));
    assert.equal(result.status, "unsupported");
    assert.match(result.message, /当前供应商接入/);
    assert.match(result.message, /不能据此判断上游/);
  }
  assert.equal(calls, 0);
});

test("upstream failures are inconclusive, do not echo private details and never retry or write dumps", async () => {
  const directory = await mkdtemp(join(tmpdir(), "model-probe-"));
  const config = createTestAppConfig();
  config.dataDir = directory;
  config.llm.debugDump.enabled = true;
  try {
    for (const status of [400, 401, 403, 404, 429, 500, 503]) {
      let calls = 0;
      setFetchImplementationForTests(async () => { calls++; return new Response("upstream echoed draft-secret and private text", { status }); });
      const result = await new ModelCapabilityProbe(config).run(input("chat"));
      assert.equal(result.status, "inconclusive");
      assert.equal(calls, 1);
      assert.doesNotMatch(JSON.stringify(result), /draft-secret|private text|upstream echoed/);
      assert.deepEqual(await readdir(directory), []);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("pre-cancellation sends no requests and active cancellation releases the per-instance probe lock", async () => {
  const probe = new ModelCapabilityProbe(createTestAppConfig());
  let calls = 0;
  let reached!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; });
  setFetchImplementationForTests(async (_url, init) => {
    calls++;
    reached();
    return new Promise((_resolve, reject) => { init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); });
  });
  const cancelled = await probe.run(input("chat", { abortSignal: AbortSignal.abort() }));
  assert.equal(cancelled.status, "inconclusive");
  assert.equal(calls, 0);
  const controller = new AbortController();
  const active = probe.run(input("chat", { abortSignal: controller.signal }));
  await started;
  await assert.rejects(probe.run(input("embedding")), ModelCapabilityProbeBusyError);
  controller.abort();
  assert.equal((await active).status, "inconclusive");
  setFetchImplementationForTests(async () => chat());
  assert.equal((await probe.run(input("chat"))).status, "passed");
});

test("official transcription uses an in-memory WAV rather than user audio and accepts a valid silence response", async () => {
  setFetchImplementationForTests(async (url, init) => {
    assert.equal(url, "https://draft.example/v1/audio/transcriptions");
    const form = init!.body as FormData;
    const file = form.get("file") as File;
    const audio = Buffer.from(await file.arrayBuffer());
    assert.equal(audio.toString("ascii", 0, 4), "RIFF");
    assert.equal(audio.length, 16044);
    return Response.json({ text: "" });
  });
  const result = await new ModelCapabilityProbe(createTestAppConfig()).run(input("transcription", { provider: { ...draft, type: "openai" } }));
  assert.equal(result.status, "passed");
  assert.match(result.message, /不代表识别准确率/);
});

test("media and decisions are only requested when selected and probe results do not return generated contents", async () => {
  const probe = new ModelCapabilityProbe(createTestAppConfig());
  for (const operation of ["speech", "decision", "image"] as const) {
    let calls = 0;
    setFetchImplementationForTests(async (url, init) => {
      calls++;
      const body = JSON.parse(String(init!.body));
      if (operation === "speech") {
        assert.equal(url, "https://draft.example/v1/audio/speech");
        assert.equal(body.input, "你好");
        return new Response(new Uint8Array([73, 68, 51, 0]), { headers: { "content-type": "audio/mpeg" } });
      }
      if (operation === "decision") {
        assert.equal(url, "https://draft.example/v1/decisions");
        return Response.json({ answers: [{ name: "greeting", type: "predicate", probability: 0.9 }] });
      }
      assert.equal(url, "https://draft.example/v1/images/generations");
      assert.equal(body.n, 1);
      assert.equal(body.quality, "low");
      const buffer = await sharp({ create: { width: 8, height: 8, channels: 3, background: "white" } }).png().toBuffer();
      return Response.json({ data: [{ b64_json: buffer.toString("base64") }] });
    });
    const result = await probe.run(input(operation, { provider: { ...draft, type: "openai" } }));
    assert.equal(result.status, "passed", `${operation}: ${result.message}`);
    assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(result), /buffer|base64|b64_json/);
  }
});

test("image probe uses a declared quality when low is not accepted", async () => {
  const probe = new ModelCapabilityProbe(createTestAppConfig());
  let calls = 0;
  setFetchImplementationForTests(async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init!.body));
    assert.equal(body.quality, "medium");
    assert.equal(body.size, "512x512");
    const buffer = await sharp({ create: { width: 8, height: 8, channels: 3, background: "white" } }).png().toBuffer();
    return Response.json({ data: [{ b64_json: buffer.toString("base64") }] });
  });
  const result = await probe.run(input("image", { provider: { ...draft, type: "openai" }, model: {
    upstreamModel: "image-model", image: { constraints: { qualities: ["medium", "high"], sizes: ["1024x1024", "512x512"] }, defaults: { quality: "high", size: "1024x1024" } }
  } }));
  assert.equal(result.status, "passed");
  assert.equal(calls, 1);
});

test("official Responses probe bounds output, disables search, and treats an exhausted budget as unconfirmed", async () => {
  const probe = new ModelCapabilityProbe(createTestAppConfig());
  for (const completed of [true, false]) {
    let calls = 0;
    setFetchImplementationForTests(async (url, init) => {
      calls++;
      assert.equal(url, "https://draft.example/v1/responses");
      const body = JSON.parse(String(init!.body));
      assert.equal(body.max_output_tokens, 32);
      assert.equal(body.store, false);
      assert.equal(body.tools, undefined);
      assert.deepEqual(body.reasoning, { effort: "none" });
      return completed
        ? createSseResponse([{ type: "response.completed", response: { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "好" }] }] } }])
        : createSseResponse([{ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }]);
    });
    const result = await probe.run(input("chat", { provider: { ...draft, type: "openai" }, model: {
      upstreamModel: "reasoning-model", chat: { capabilities: { supportsThinking: true, thinkingControllable: true, supportsSearch: true }, searchEnabled: true }
    } }));
    assert.equal(result.status, completed ? "passed" : "inconclusive");
    assert.equal(calls, 1);
  }
});

test("image tests discard both successful output and failure diagnostics without writing instance data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "model-probe-image-"));
  const config = createTestAppConfig();
  config.dataDir = directory;
  config.llm.debugDump.enabled = true;
  try {
    const buffer = await sharp({ create: { width: 8, height: 8, channels: 3, background: "white" } }).png().toBuffer();
    for (const response of [new Response("failure", { status: 500 }), Response.json({ data: [{ b64_json: buffer.toString("base64") }] })]) {
      setFetchImplementationForTests(async () => response);
      await new ModelCapabilityProbe(config).run(input("image", { provider: { ...draft, type: "openai" } }));
      assert.deepEqual(await readdir(directory), []);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
