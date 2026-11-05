import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import pino from "pino";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { generateConfiguredImage, isImageGenerationAvailable } from "#services/images/imageGeneration.ts";
import { setFetchImplementationForTests } from "#services/proxy/index.ts";
import { imageGenerationToolHandlers } from "#llm/tools/runtime/imageGenerationTools.ts";
import type { BuiltinToolContext } from "#llm/tools/core/shared.ts";
import { withTempDir } from "../helpers/config-test-support.tsx";
import { ChatFileStore } from "#services/workspace/chatFileStore.ts";
import { LocalFileService } from "#services/workspace/localFileService.ts";
import { ModelCapabilityProbe } from "#llm/provider/modelCapabilityProbe.ts";

const png = await sharp({ create: { width: 8, height: 6, channels: 3, background: "blue" } }).png().toBuffer();
const imagePart = { inlineData: { mimeType: "image/png", data: png.toString("base64") } };
const success = () => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ ...imagePart, thought: true }, { text: "生成说明" }, imagePart] } }] });
function config() {
  return createTestAppConfig({ llm: { enabled: true, imageGeneration: { enabled: true }, providers: { images: { type: "google", baseUrl: "https://google.example/v1beta", apiKey: "synthetic-key", proxy: false } }, models: { image: { provider: "images", model: "arbitrary-image-model", image: { capabilities: { referenceImages: true }, constraints: { aspectRatios: ["1:1", "16:9"], resolutions: ["1K", "2K"], maxReferenceImages: 2 }, defaults: { aspect_ratio: "1:1", resolution: "1K" } } } }, routingPresets: { test: { imageGenerator: ["image"] } } }, chatFiles: { enabled: true, maxUploadBytes: 1024 * 1024 } });
}
afterEach(() => setFetchImplementationForTests(null));

test("Google 原生图片通过受控 SDK 生成，忽略思考预览图并复用图片验证", async () => {
  const c = config(); assert.equal(isImageGenerationAvailable(c), true);
  setFetchImplementationForTests(async (url, init) => {
    assert.equal(url, "https://google.example/v1beta/models/arbitrary-image-model:generateContent");
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.contents, [{ role: "user", parts: [{ text: "蓝色圆形" }] }]);
    assert.equal(body.store, false); assert.deepEqual(body.generationConfig.responseModalities, ["IMAGE"]);
    assert.deepEqual(body.generationConfig.imageConfig, { aspectRatio: "16:9", imageSize: "2K" });
    assert.equal(body.generationConfig.thinkingConfig, undefined); assert.equal(body.n, undefined);
    assert.equal(new Headers(init?.headers as HeadersInit).get("x-goog-api-key"), "synthetic-key");
    return success();
  });
  const image = await generateConfiguredImage(c, { prompt: "蓝色圆形", aspectRatio: "16:9", resolution: "2K", skipDebugDump: true });
  assert.deepEqual(image.buffer, png); assert.equal(image.mimeType, "image/png"); assert.equal(image.width, 8); assert.equal(image.height, 6);
});

test("Google 编辑引用图使用内联已验证资产，不发送 multipart 或蒙版", async () => {
  const c = config();
  setFetchImplementationForTests(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.contents[0].parts, [{ text: "把蓝色改为红色" }, imagePart]);
    assert.equal(body.mask, undefined); return success();
  });
  await generateConfiguredImage(c, { prompt: "把蓝色改为红色", referenceImages: [{ buffer: png }], skipDebugDump: true });
});

test("Google 不支持的参数、蒙版、参考图数量和无效素材在请求前拒绝", async () => {
  let calls = 0; setFetchImplementationForTests(async () => { calls++; throw new Error("不应请求"); });
  for (const input of [{ quality: "high" }, { size: "1024x1024" }, { outputFormat: "gif" }, { outputFormat: "png" }, { frameCount: 2 }, { resolution: "4K" }, { aspectRatio: "3:1" }, { referenceImages: [{ buffer: png }], mask: { buffer: png } }, { referenceImages: Array(3).fill({ buffer: png }) }, { referenceImages: [{ buffer: Buffer.from("bad") }] }]) {
    await assert.rejects(generateConfiguredImage(config(), { prompt: "图片", skipDebugDump: true, ...input }));
  }
  assert.equal(calls, 0);
});

for (const candidate of [{ finishReason: "MAX_TOKENS", content: { parts: [imagePart] } }, { finishReason: "SAFETY" }, { finishReason: "IMAGE_RECITATION" }, { finishReason: "STOP", content: { parts: [{ text: "没有图片" }] } }, { finishReason: "STOP", content: { parts: [imagePart, imagePart] } }, { finishReason: "STOP", content: { parts: [{ inlineData: { mimeType: "image/png", data: "bad" } }] } }]) {
  test(`Google 图片拒绝异常终态或异常最终图片 ${JSON.stringify(candidate).slice(0, 65)}`, async () => {
    let calls = 0; setFetchImplementationForTests(async () => { calls++; return Response.json({ candidates: [candidate] }); });
    await assert.rejects(generateConfiguredImage(config(), { prompt: "图片", skipDebugDump: true })); assert.equal(calls, 1);
  });
}

test("Google 图片响应超过字节上限被取消，HTTP 错误无重试且不泄漏密钥", async () => {
  let cancelled = false;
  const c = config(); c.chatFiles.maxUploadBytes = 16;
  setFetchImplementationForTests(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(70000)); }, cancel() { cancelled = true; } }), { headers: { "content-type": "application/json" } }));
  await assert.rejects(generateConfiguredImage(c, { prompt: "图片", skipDebugDump: true }), /超过大小限制/); assert.equal(cancelled, true);
  let calls = 0; setFetchImplementationForTests(async () => { calls++; return Response.json({ error: { code: 429, message: "quota synthetic-key" } }, { status: 429 }); });
  await assert.rejects(generateConfiguredImage(config(), { prompt: "图片", skipDebugDump: true }), error => error instanceof Error && /429/.test(error.message) && !error.message.includes("synthetic-key"));
  assert.equal(calls, 1);
});

test("Google 图片工具产物进入统一资产库，能力探测使用同一路径", async () => {
  await withTempDir("google-image-assets", async dir => {
    const c = config(); c.dataDir = dir; c.localFiles.root = dir;
    const store = new ChatFileStore(c, pino({ level: "silent" }), new LocalFileService(c, dir)); await store.init();
    setFetchImplementationForTests(async () => success());
    const context = { config: c, chatFileStore: store, replyDelivery: "web", lastMessage: { sessionId: "web:test", userId: "owner", senderName: "测试" } } as unknown as BuiltinToolContext;
    const reply = JSON.parse(String(await imageGenerationToolHandlers.generate_image!({ id: "image", type: "function", function: { name: "generate_image", arguments: "{}" } }, { prompt: "图片", aspect_ratio: "16:9", resolution: "2K" }, context)));
    assert.equal(reply.ok, true); assert.equal((await store.getFile(reply.file_id))?.kind, "image");
    const probe = await new ModelCapabilityProbe(c).run({ provider: { type: "google", apiKey: "synthetic-key", proxy: false }, model: { upstreamModel: "arbitrary-image-model", image: {} }, operation: "image" });
    assert.equal(probe.status, "passed");
  });
});
