import { commonToolResultCompactors } from "../../src/llm/tools/core/resultObservation.ts";
import { listTurnToolsets } from "../../src/llm/tools/toolsetSelectionPolicy.ts";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { setFetchImplementationForTests } from "../../src/services/proxy/index.ts";
import { generateConfiguredImage, isImageGenerationAvailable } from "../../src/services/images/imageGeneration.ts";
import { resolveModelRefsForRole } from "../../src/llm/shared/modelRouting.ts";
import { normalizeRoutingPresetTargetCatalog } from "../../src/llm/shared/modelTarget.ts";
import { llmRoutingPresetCatalogFileSchema } from "../../src/config/configModel.ts";
import { parseConfig } from "../../src/data/schema/index.ts";
import { imageGenerationToolHandlers } from "../../src/llm/tools/runtime/imageGenerationTools.ts";
import type { BuiltinToolContext } from "../../src/llm/tools/core/shared.ts";
import { ChatFileStore } from "../../src/services/workspace/chatFileStore.ts";
import { LocalFileService } from "../../src/services/workspace/localFileService.ts";
import { withTempDir } from "../helpers/config-test-support.tsx";
import pino from "pino";

function config() {
  return createTestAppConfig({
    llm: {
    enabled: true, imageGeneration: { enabled: true }, routingPreset: "test",
    providers: { images: { type: "openai_responses_compatible", baseUrl: "https://images.example/v1/", apiKey: "test-only" } },
    models: {
      image: {
        provider: "images",
        model: "upstream-image",
        image: { defaults: { size: "1024x1024", quality: "low" } }
      }
    },
    routingPresets: { test: { imageGenerator: ["image"] } }
  }, chatFiles: { enabled: true, maxUploadBytes: 1024 * 1024 }
});
}
const png = await sharp({ create: { width: 8, height: 6, channels: 3, background: "orange" } }).png().toBuffer();
afterEach(() => setFetchImplementationForTests(null));

test("标准生图按路由发送模型参数，隔离对话参数并解析 Base64", async () => {
  let calls = 0;
  setFetchImplementationForTests(async (url, init) => {
    calls++;
    assert.equal(url, "https://images.example/v1/images/generations");
    assert.deepEqual(JSON.parse(String(init?.body)), { model: "upstream-image", prompt: "小猫", n: 1, size: "512x512", quality: "low" });
    assert.equal((init?.headers as Record<string,string>).Authorization, "Bearer test-only");
    return Response.json({ data: [{ b64_json: png.toString("base64") }] });
  });
  const result = await generateConfiguredImage(config(), { prompt: "小猫", size: "512x512" });
  assert.equal(result.width, 8);
  assert.equal(result.height, 6);
  assert.equal(result.mimeType, "image/png");
  assert.deepEqual(result.buffer, png);
  assert.equal(calls, 1);
});

test("URL 结果下载不携带供应商密钥", async () => {
  setFetchImplementationForTests(async (url, init) => {
    if (url.includes("/images/generations")) return Response.json({ data: [{ url: "https://storage.example/image.png" }] });
    assert.equal(init?.headers, undefined);
    return new Response(new Uint8Array(png));
  });
  assert.deepEqual((await generateConfiguredImage(config(), { prompt: "图片" })).buffer, png);
});

test("失败、无效响应、超限和取消均不会重试", async () => {
  for (const response of [new Response("failed", { status: 503 }), Response.json({ data: [] }), Response.json({ data: [{ b64_json: "invalid" }] }), Response.json({ data: [{ b64_json: Buffer.from("not image").toString("base64") }] }), new Response("", { headers: { "content-length": "99999999" } })]) {
    let calls = 0;
    setFetchImplementationForTests(async () => { calls++; return response; });
    await assert.rejects(generateConfiguredImage(config(), { prompt: "图片" }));
    assert.equal(calls, 1);
  }
  setFetchImplementationForTests(async () => { throw new Error("不应调用"); });
  await assert.rejects(generateConfiguredImage(config(), { prompt: "图片", abortSignal: AbortSignal.abort() }), /abort/i);
  const c = config(); c.llm.imageGeneration.timeoutMs = 5;
  setFetchImplementationForTests(async (_url, init) => new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout failed")), 100);
    init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal?.reason); }, { once: true });
  }));
  await assert.rejects(generateConfiguredImage(c, { prompt: "图片" }), /timeout/i);
});

test("生图路由保留复合模型身份、继承默认且过滤错误模型类型", () => {
  const parsed = parseConfig(llmRoutingPresetCatalogFileSchema, { default: { imageGenerator: [{ provider: "images", model: "image" }] } });
  assert.deepEqual(normalizeRoutingPresetTargetCatalog(parsed).default?.imageGenerator, ["images/image"]);
  const c = config();
  c.llm.routingPresets = { default: { imageGenerator: ["image"] }, test: {} };
  assert.deepEqual(resolveModelRefsForRole(c, "image_generator").acceptedModelRefs, ["image"]);
  assert.equal(isImageGenerationAvailable(c), true);
  const imageSettings = c.llm.models.image!.image;
  delete c.llm.models.image!.image;
  assert.equal(isImageGenerationAvailable(c), false);
  c.llm.models.image!.image = imageSettings!;
  c.llm.routingPresets.test = { imageGenerator: [] };
  assert.equal(isImageGenerationAvailable(c), false);
});

test("工具生成图片后导入资产并返回发送句柄", async () => {
  await withTempDir("image-generation", async dir => {
    const c = config(); c.localFiles.root = dir;
    const logger = pino({ level: "silent" });
    const store = new ChatFileStore(c, logger, new LocalFileService(c, dir));
    await store.init();
    setFetchImplementationForTests(async () => Response.json({ data: [{ b64_json: png.toString("base64") }] }));
    const context = { config: c, chatFileStore: store } as BuiltinToolContext;
    const result = JSON.parse(String(await imageGenerationToolHandlers.generate_image!({ id: "image", type: "function", function: { name: "generate_image", arguments: "{}" } }, { prompt: "小猫" }, context)));
    assert.equal(result.ok, true);
    assert.ok(result.asset_ref);
    assert.ok(result.asset_handle);
    assert.equal((await store.getFile(result.file_id))?.origin, "image_generated");
  });
});


test("两种生图工具可按实例配置和会话偏好独立启停", () => {
  const c = config();
  const visible = (overrides: Record<string, "enabled" | "disabled"> = {}) => listTurnToolsets({
    config: c, relationship: "owner", currentUser: null, modelRef: ["main"], includeDebugTools: false,
    modeId: "assistant", toolsetPreferences: { overrides }
  }).filter(item => ["image_generation", "comfy_image"].includes(item.id)).flatMap(item => item.toolNames);
  c.comfy.enabled = false;
  assert.deepEqual(visible(), ["generate_image"]);
  c.comfy.enabled = true;
  assert.deepEqual(visible(), ["generate_image", "generate_image_with_comfyui"]);
  assert.deepEqual(visible({ comfy_image: "disabled" }), ["generate_image"]);
  assert.deepEqual(visible({ image_generation: "disabled" }), ["generate_image_with_comfyui"]);
  assert.deepEqual(visible({ image_generation: "disabled", comfy_image: "disabled" }), []);
  c.llm.imageGeneration.enabled = false;
  assert.deepEqual(visible({ image_generation: "enabled" }), ["generate_image_with_comfyui"]);
  c.comfy.enabled = false;
  assert.deepEqual(visible({ comfy_image: "enabled" }), []);
});

test("生图路由跳过不支持标准协议的首项而不执行失败重试", () => {
  const c = config();
  c.llm.providers.unsupported = { ...c.llm.providers.images!, type: "google" };
  const validRef = resolveModelRefsForRole(c, "image_generator").acceptedModelRefs[0]!;
  c.llm.models.unsupported = { ...c.llm.models[validRef]!, provider: "unsupported" };
  c.llm.routingPresets.test!.imageGenerator = ["unsupported", validRef];
  assert.equal(isImageGenerationAvailable(c), true);
});

test("生图 HTTP 错误保留响应详情和独立失败 dump", async () => {
  await withTempDir("image-error-dump", async (directory) => {
    const c = config();
    c.dataDir = directory;
    c.llm.debugDump.enabled = false;
    const raw = JSON.stringify({ error: { code: "invalid_size", message: "unsupported image size" } });
    setFetchImplementationForTests(async () => new Response(raw, { status: 400 }));
    await assert.rejects(generateConfiguredImage(c, { prompt: "小猫" }), /HTTP 400.*invalid_size.*unsupported image size/);
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const dump = JSON.parse(await readFile(join(directory, "dump/last-failed-image-exchange.json"), "utf8"));
    assert.equal(dump.exchanges[0].rawBody, raw);
    assert.equal(dump.exchanges[0].status, 400);
  });
});

test("OpenRouter 图像端点使用专属参数并在请求前校验范围", async () => {
  const value = config();
  value.llm.providers.images!.type = "openrouter";
  value.llm.models.image!.image!.defaults = { resolution: "1K", aspect_ratio: "1:1" };
  value.llm.models.image!.image!.constraints = { resolutions: ["1K", "2K"], aspectRatios: ["1:1"] };
  let requests = 0;
  setFetchImplementationForTests(async (url, init) => {
    requests++;
    assert.equal(url, "https://images.example/v1/images");
    assert.deepEqual(JSON.parse(String(init?.body)), { model: "upstream-image", prompt: "测试", n: 1, resolution: "1K", aspect_ratio: "1:1" });
    return Response.json({ data: [{ b64_json: png.toString("base64"), media_type: "image/png" }] });
  });
  await generateConfiguredImage(value, { prompt: "测试" });
  await assert.rejects(generateConfiguredImage(value, { prompt: "测试", size: "1024x1024" }), /不使用 size/);
  value.llm.models.image!.image!.defaults.resolution = "invalid";
  await assert.rejects(generateConfiguredImage(value, { prompt: "测试" }), /不在模型声明/);
  assert.equal(requests, 1);
});

test("官方原生编辑上传参考图片及蒙版，继承模型参数并只请求一次", async () => {
  const c = config();
  c.llm.providers.images!.type = "openai";
  c.llm.models.image!.image!.capabilities.referenceImages = true;
  const mask = await sharp({ create: { width: 8, height: 6, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  let requests = 0;
  setFetchImplementationForTests(async (url, init) => {
    requests++;
    assert.equal(url, "https://images.example/v1/images/edits");
    const body = init!.body as import("undici").FormData;
    assert.equal(body.get("model"), "upstream-image");
    assert.equal(body.get("prompt"), "把背景改成蓝色");
    assert.equal(body.get("n"), "1");
    assert.equal(body.get("quality"), "low");
    assert.equal(body.getAll("image[]").length, 1);
    const file = body.get("image[]") as File;
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), png);
    assert.equal(file.type, "image/png");
    assert.ok(body.get("mask"));
    assert.equal((init?.headers as Record<string, string>)["Content-Type"], undefined);
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-only");
    return Response.json({ data: [{ b64_json: png.toString("base64") }] });
  });
  const result = await generateConfiguredImage(c, { prompt: "把背景改成蓝色", referenceImages: [{ buffer: png }], mask: { buffer: mask } });
  assert.deepEqual(result.buffer, png);
  assert.equal(requests, 1);
});

test("参考图、蒙版与编辑能力在发请求前校验", async () => {
  const c = config();
  let requests = 0;
  setFetchImplementationForTests(async () => { requests++; throw new Error("不应请求"); });
  await assert.rejects(generateConfiguredImage(c, { prompt: "编辑", referenceImages: [{ buffer: png }] }), /支持参考图编辑/);
  c.llm.models.image!.image!.capabilities.referenceImages = true;
  await assert.rejects(generateConfiguredImage(c, { prompt: "编辑", referenceImages: [{ buffer: Buffer.from("not image") }] }));
  await assert.rejects(generateConfiguredImage(c, { prompt: "编辑", referenceImages: Array.from({ length: 17 }, () => ({ buffer: png })) }), /数量/);
  await assert.rejects(generateConfiguredImage(c, { prompt: "编辑", mask: { buffer: png } }), /参考图/);
  await assert.rejects(generateConfiguredImage(c, { prompt: "编辑", referenceImages: [{ buffer: png }], mask: { buffer: png } }), /蒙版/);
  c.chatFiles.maxUploadBytes = png.length;
  await assert.rejects(generateConfiguredImage(c, { prompt: "编辑", referenceImages: [{ buffer: png }, { buffer: png }] }), /总大小/);
  assert.equal(requests, 0);
});

test("编辑工具只接受已导入的静态图片资产并返回新资产", async () => {
  await withTempDir("image-edit-assets", async dir => {
    const c = config(); c.localFiles.root = dir;
    c.llm.models.image!.image!.capabilities.referenceImages = true;
    const logger = pino({ level: "silent" });
    const store = new ChatFileStore(c, logger, new LocalFileService(c, dir));
    await store.init();
    const source = await store.importBuffer({ buffer: png, sourceName: "source.png", mimeType: "image/png", kind: "image", origin: "image_generated" });
    let requests = 0;
    setFetchImplementationForTests(async () => { requests++; return Response.json({ data: [{ b64_json: png.toString("base64") }] }); });
    const context = { config: c, chatFileStore: store } as BuiltinToolContext;
    const call = { id: "image", type: "function", function: { name: "generate_image", arguments: "{}" } } as const;
    const rejected = JSON.parse(String(await imageGenerationToolHandlers.generate_image!(call, { prompt: "编辑", reference_images: ["/tmp/not-an-asset.png"] }, context)));
    assert.equal(rejected.ok, false);
    assert.equal(requests, 0);
    const edited = JSON.parse(String(await imageGenerationToolHandlers.generate_image!(call, { prompt: "编辑", reference_images: [source.fileRef] }, context)));
    assert.equal(edited.ok, true);
    assert.notEqual(edited.file_id, source.fileId);
    assert.ok(edited.asset_handle);
    assert.equal(requests, 1);
  });
});

test("官方图像不发送兼容专用 response_format 参数", async () => {
  const c = config();
  c.llm.providers.images!.type = "openai";
  c.llm.models.image!.image!.defaults.response_format = "b64_json";
  setFetchImplementationForTests(async () => { throw new Error("不应请求"); });
  await assert.rejects(generateConfiguredImage(c, { prompt: "图片" }), /response_format/);
});

test("局部重绘接受灰度透明 PNG 蒙版", async () => {
  const c = config();
  c.llm.providers.images!.type = "openai";
  c.llm.models.image!.image!.capabilities.referenceImages = true;
  const mask = await sharp({ create: { width: 8, height: 6, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .toColourspace("b-w").png().toBuffer();
  assert.equal((await sharp(mask).metadata()).channels, 2);
  setFetchImplementationForTests(async (_url, init) => {
    assert.ok((init!.body as import("undici").FormData).get("mask"));
    return Response.json({ data: [{ b64_json: png.toString("base64") }] });
  });
  const result = await generateConfiguredImage(c, { prompt: "局部编辑", referenceImages: [{ buffer: png }], mask: { buffer: mask } });
  assert.deepEqual(result.buffer, png);
});

test("生图工具返回参数错误详情，过滤供应商密钥，不重试", async () => {
  let calls = 0;
  setFetchImplementationForTests(async () => {
    calls++;
    return Response.json({ error: { message: "size must be 1024x1024; test-only", code: "invalid_size", type: "invalid_request_error", param: "size" } }, { status: 400 });
  });
  const result = JSON.parse(String(await imageGenerationToolHandlers.generate_image!({} as never,
    { prompt: "测试", size: "123x123" }, { config: config() } as BuiltinToolContext)));
  assert.equal(result.ok, false);
  assert.equal(result.detail.httpStatus, 400);
  assert.equal(result.detail.param, "size");
  assert.equal(result.detail.code, "invalid_size");
  const compacted = commonToolResultCompactors.error_summary!({
    toolName: "generate_image", toolCallId: "test", args: {}, rawContent: JSON.stringify(result),
    parsedContent: result, rawLength: 0, estimatedTokens: 0, resource: null, refetchHint: null, pinned: false
  });
  assert.match(compacted.replayContent, /size/);
  assert.match(compacted.replayContent, /invalid_size/);
  assert.match(result.error, /1024x1024/);
  assert.doesNotMatch(JSON.stringify(result), /test-only/);
  assert.equal(calls, 1);
});

test("生图网络错误返回底层原因，明确没有API响应", async () => {
  setFetchImplementationForTests(async () => {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("connection refused https://user:pass@example.test/?token=secret"), { code: "ECONNREFUSED" }) });
  });
  const result = JSON.parse(String(await imageGenerationToolHandlers.generate_image!({} as never,
    { prompt: "测试" }, { config: config() } as BuiltinToolContext)));
  assert.equal(result.detail.kind, "transport");
  assert.equal(result.detail.httpStatus, undefined);
  assert.match(result.error, /ECONNREFUSED/);
  assert.doesNotMatch(result.error, /pass|token=secret/);
});

test("HTTP成功状态中的显式API错误仍返回可调整参数的详情", async () => {
  setFetchImplementationForTests(async () => Response.json({ error: { message: "Unsupported quality", param: "quality", code: "invalid_quality" } }));
  const result = JSON.parse(String(await imageGenerationToolHandlers.generate_image!({} as never,
    { prompt: "测试" }, { config: config() } as BuiltinToolContext)));
  assert.equal(result.ok, false);
  assert.equal(result.detail.param, "quality");
  assert.match(result.error, /Unsupported quality/);
});

test("生图成功状态返回非JSON时不回显正文及密钥", async () => {
  setFetchImplementationForTests(async () => new Response("<html>test-only upstream error</html>"));
  const result = JSON.parse(String(await imageGenerationToolHandlers.generate_image!({} as never,
    { prompt: "测试" }, { config: config() } as BuiltinToolContext)));
  assert.equal(result.detail.kind, "protocol");
  assert.doesNotMatch(JSON.stringify(result), /test-only|<html>/);
});

test("图片下载响应体断流时返回下载阶段及底层网络原因", async () => {
  setFetchImplementationForTests(async url => {
    if (url.includes("/images/generations")) return Response.json({ data: [{ url: "https://storage.example/image.png" }] });
    return new Response(new ReadableStream({ start(controller) {
      controller.error(new TypeError("terminated", { cause: Object.assign(new Error("socket closed"), { code: "ECONNRESET" }) }));
    } }));
  });
  const result = JSON.parse(String(await imageGenerationToolHandlers.generate_image!({} as never,
    { prompt: "测试" }, { config: config() } as BuiltinToolContext)));
  assert.equal(result.detail.stage, "download");
  assert.equal(result.detail.kind, "transport");
  assert.match(result.error, /ECONNRESET/);
});
