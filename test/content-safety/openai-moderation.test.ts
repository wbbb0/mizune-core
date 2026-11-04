import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { withMockFetch } from "../helpers/llm-test-support.tsx";
import { createOpenAiContentModerationProvider } from "../../src/contentSafety/providers/openAiContentModerationProvider.ts";
import type { OpenAiContentSafetyProviderConfig } from "../../src/config/contentSafetyConfig.ts";

function provider(overrides: Partial<OpenAiContentSafetyProviderConfig> = {}) {
  const config = createTestAppConfig({ contentSafety: { providers: { openai: { type: "openai_moderation", apiKey: "test-key", ...overrides } } } });
  config.proxy.https = { type: "http", host: "127.0.0.1", port: 7890 };
  const settings = config.contentSafety.providers.openai!;
  assert.equal(settings.type, "openai_moderation");
  if (settings.type !== "openai_moderation") throw new Error("unexpected provider");
  return createOpenAiContentModerationProvider("openai", settings, config);
}

function response(flagged = false, score = 0.05) {
  return Response.json({ id: "mod-test", results: [{ flagged, categories: { violence: flagged }, category_scores: { violence: score } }] }, { headers: { "x-request-id": "req-test" } });
}

test("OpenAI moderation uses native endpoint, dedicated credentials/model/proxy and normalizes confidence to 0-100", async () => {
  const p = provider({ proxy: true, baseUrl: "https://example.test/v1/", model: "omni-moderation-2024-09-26" });
  await withMockFetch([{
    assertRequest(body: unknown, _index: number, init: any, url: string) {
      assert.equal(url, "https://example.test/v1/moderations");
      assert.equal(init.headers.Authorization, "Bearer test-key");
      assert.ok(init.dispatcher);
      assert.deepEqual(body, { input: "公开测试文本", model: "omni-moderation-2024-09-26" });
    },
    response: response(true, 0.9)
  }], async () => {
    const result = await p.moderateText!({ subjectKind: "text", text: "公开测试文本", context: {} });
    assert.equal(result.decision, "block");
    assert.equal(result.providerType, "openai_moderation");
    assert.equal(result.requestId, "req-test");
    assert.equal(result.labels[0]?.confidence, 90);
    assert.equal(result.labels[0]?.riskLevel, "high");
    assert.equal(p.capabilities.has("audio"), false);
    assert.equal(p.capabilities.has("audio_transcript"), true);
  });
});

test("unflagged OpenAI scores remain available for application thresholds without becoming high risk", async () => {
  await withMockFetch([{ assertRequest() {}, response: response(false, 0.4) }], async () => {
    const result = await provider().moderateText!({ subjectKind: "audio_transcript", text: "公开转写示例", context: {} });
    assert.equal(result.decision, "allow");
    assert.equal(result.labels[0]?.confidence, 40);
    assert.equal(result.labels[0]?.riskLevel, "none");
  });
});

test("local static images use detected MIME and base64; public image URLs are passed without local upload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openai-moderation-image-"));
  try {
    const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).png().toBuffer();
    const path = join(dir, "image.bin");
    await writeFile(path, image);
    await withMockFetch([
      { assertRequest(body: any) { assert.equal(body.input[0].image_url.url, `data:image/png;base64,${image.toString("base64")}`); }, response: response() },
      { assertRequest(body: any) { assert.deepEqual(body.input, [{ type: "image_url", image_url: { url: "https://example.test/image.png" } }]); }, response: response() }
    ], async () => {
      const p = provider();
      assert.equal((await p.moderateMedia!({ subjectKind: "emoji", absolutePath: path, context: {} })).decision, "allow");
      await p.moderateMedia!({ subjectKind: "image", absolutePath: "https://example.test/image.png", context: {} });
    });
    await withMockFetch([], async () => {
      await assert.rejects(provider().moderateMedia!({ subjectKind: "audio", absolutePath: path, context: {} }), /仅支持文本和图片/);
      await writeFile(path, "invalid image");
      await assert.rejects(provider().moderateMedia!({ subjectKind: "image", absolutePath: path, context: {} }), /静态 GIF/);
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("credentials may come from an environment variable and missing keys do not issue requests", async () => {
  const envName = "LLM_TEST_MODERATION_KEY";
  const before = process.env[envName];
  process.env[envName] = "env-key";
  try {
    const config = createTestAppConfig({ contentSafety: { providers: { openai: { type: "openai_moderation", apiKeyEnv: envName } } } });
    const settings = config.contentSafety.providers.openai!;
    if (settings.type !== "openai_moderation") throw new Error("unexpected provider");
    const p = createOpenAiContentModerationProvider("openai", settings, config);
    await withMockFetch([{ assertRequest(_body: unknown, _index: number, init: any) { assert.equal(init.headers.Authorization, "Bearer env-key"); }, response: response() }], async () => {
      await p.moderateText!({ subjectKind: "text", text: "测试", context: {} });
    });
    delete process.env[envName];
    await withMockFetch([], async () => {
      await assert.rejects(p.moderateText!({ subjectKind: "text", text: "测试", context: {} }), /缺少 API Key/);
    });
  } finally {
    if (before === undefined) delete process.env[envName]; else process.env[envName] = before;
  }
});

for (const invalid of [
  { results: [] },
  { id: "mod", results: [{ flagged: false, categories: {}, category_scores: { violence: 2 } }] },
  { id: "mod", results: [{ categories: {}, category_scores: {} }] }
]) {
  test("invalid moderation responses are rejected instead of becoming allow results", async () => {
    await withMockFetch([{ assertRequest() {}, response: Response.json(invalid) }], async () => {
      await assert.rejects(provider().moderateText!({ subjectKind: "text", text: "测试", context: {} }), /无效审核结果/);
    });
  });
}

test("upstream response bodies and network errors cannot expose content or credentials", async () => {
  for (const scenario of [
    { response: new Response("private text test-key", { status: 401 }) },
    { error: new Error("private text test-key") }
  ]) {
    await withMockFetch([{ assertRequest() {}, ...scenario }], async () => {
      await assert.rejects(provider().moderateText!({ subjectKind: "text", text: "private text", context: {} }), error => {
        assert.doesNotMatch(String(error), /private text|test-key/);
        return true;
      });
    });
  }
});

test("caller cancellation and request timeout abort the actual moderation request", async () => {
  const controller = new AbortController();
  controller.abort();
  await withMockFetch([], async () => {
    await assert.rejects(provider().moderateText!({ subjectKind: "text", text: "测试", context: {}, abortSignal: controller.signal }));
  });
  const p = provider({ timeoutMs: 10 });
  const { setFetchImplementationForTests } = await import("../../src/services/proxy/index.ts");
  setFetchImplementationForTests(async (_url, init) => {
    const signal = init?.signal!;
    return await new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      const keepAlive = setTimeout(() => reject(new Error("timeout did not abort fetch")), 500);
      signal.addEventListener("abort", () => clearTimeout(keepAlive), { once: true });
    });
  });
  try { await assert.rejects(p.moderateText!({ subjectKind: "text", text: "测试", context: {} }), /取消或超时/); }
  finally { setFetchImplementationForTests(null); }
});
