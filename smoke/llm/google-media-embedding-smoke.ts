import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fetch as directFetch } from "undici";
import pino from "pino";
import { loadConfig } from "#config/config.ts";
import { llmCatalogFileSchema } from "#config/configModel.ts";
import { normalizeLlmCatalog } from "#llm/shared/modelTarget.ts";
import { LlmClient } from "#llm/llmClient.ts";
import { ContextEmbeddingService } from "#context/contextEmbeddingService.ts";
import { setFetchImplementationForTests } from "#services/proxy/index.ts";
import { imageGenerationToolHandlers } from "#llm/tools/runtime/imageGenerationTools.ts";
import type { BuiltinToolContext } from "#llm/tools/core/shared.ts";
import { ChatFileStore } from "#services/workspace/chatFileStore.ts";
import { LocalFileService } from "#services/workspace/localFileService.ts";

const { values } = parseArgs({ options: {
  "config-dir": { type: "string", default: "config" }, instance: { type: "string", default: "acc2" },
  "image-model": { type: "string", default: "google/nano_banana_21" },
  "pro-model": { type: "string", default: "google/nano_banana_pro" },
  "output-dir": { type: "string", default: ".superpowers/google-media-embedding/smoke" }, "only-pro": { type: "boolean", default: false }
} });
const config = loadConfig({ ...process.env, CONFIG_DIR: resolve(values["config-dir"]), CONFIG_INSTANCE: values.instance });
const provider = config.llm.providers.google;
if (provider?.type !== "google") throw new Error("未配置 Google AI Studio 供应商");
const alias = "gemini_embedding_2";
if (!config.llm.models[`google/${alias}`]?.embedding) {
  // New model profile remains isolated in memory until the release supports its schema.
  const catalog = llmCatalogFileSchema.parse({ google: { type: "google", models: { [alias]: { upstreamModel: "gemini-embedding-2", embedding: { dimensions: 768, inputMode: "task_prefix", limits: { maxInputTokens: 8192 } } } } } });
  config.llm.models[`google/${alias}`] = normalizeLlmCatalog(catalog).models[`google/${alias}`]!;
}
config.context.embedding.model = { provider: "google", model: alias };
const temporary = await mkdtemp(join(tmpdir(), "google-media-embedding-smoke-"));
const output = resolve(values["output-dir"]); await mkdir(output, { recursive: true });
config.dataDir = temporary; config.localFiles.root = temporary; config.chatFiles.root = "assets";
config.llm.debugDump.enabled = false; config.llm.imageGeneration.enabled = true; config.chatFiles.enabled = true;
const logger = pino({ level: "silent" });
const localFiles = new LocalFileService(config, temporary);
const store = new ChatFileStore(config, logger, localFiles); await store.init();
const report: Record<string, unknown>[] = [];
let lastStatus = 0;
setFetchImplementationForTests(async (url, init) => { const response = await directFetch(url, init); lastStatus = response.status; return response; });
const started = Date.now();
try {
  if (!values["only-pro"]) {
  const embedding = new ContextEmbeddingService(config, new LlmClient(config, logger), logger);
  const documents = await embedding.embedTexts(["蓝色圆形", "红色方形"], { purpose: "document" });
  const queries = await embedding.embedTexts(["蓝色圆形"], { purpose: "query" });
  assert.equal(documents.vectors.length, 2); assert.equal(queries.vectors.length, 1);
  assert.equal(documents.profile.profileId, queries.profile.profileId);
  assert.ok([...documents.vectors, ...queries.vectors].every(vector => vector.length === 768 && Math.abs(Math.hypot(...vector) - 1) < 1e-6));
  report.push({ check: "embedding", modelRef: `google/${alias}`, status: lastStatus, dimension: 768, documentCount: 2, queryCount: 1, unitNormalized: true });
  console.log(JSON.stringify(report.at(-1)));
  }
  const context = { config, chatFileStore: store, replyDelivery: "web", lastMessage: { sessionId: "web:google-smoke", userId: "smoke", senderName: "接口验证" }, projectionToolNames: ["asset_send_to_chat", "asset_media_view"] } as unknown as BuiltinToolContext;
  const generate = async (modelRef: string, edited = false, reference?: string) => {
    const model = config.llm.models[modelRef]; if (!model?.image || config.llm.providers[model.provider]?.type !== "google") throw new Error("指定图像模型未配置 Google 图像用途");
    config.llm.routingPresets[config.llm.routingPreset] = { ...config.llm.routingPresets[config.llm.routingPreset], imageGenerator: [modelRef] };
    const result = JSON.parse(String(await imageGenerationToolHandlers.generate_image!({ id: "image-smoke", type: "function", function: { name: "generate_image", arguments: "{}" } }, {
      prompt: edited ? "基于参考图重新创作一幅扁平几何海报：把圆形改为红色并移到左侧，下方加入绿色矩形，右上角加入橙色三角形，保持纯白背景，不添加文字。" : modelRef === values["pro-model"] ? "原创手绘水彩场景：一只戴橙色围巾的绿色小机器人，站在海边的紫色气象亭旁，远处三座不同高度的灯塔，清晨柔和光线。不要文字、标志或已有作品角色。" : "纯白背景中央的一个纯蓝色圆形，扁平色块，无阴影，无文字。",
      aspect_ratio: "1:1", resolution: "1K", ...(reference ? { reference_images: [reference] } : {})
    }, context)));
    if (!result.ok) throw new Error(result.error ?? "图片生成失败");
    const file = await store.getFile(result.file_id); assert.ok(file); assert.equal(file.origin, "image_generated"); assert.equal(file.kind, "image");
    const extension = file.mimeType === "image/jpeg" ? "jpg" : file.mimeType?.split("/")[1] ?? "png";
    const stem = edited ? "native-edited" : modelRef === values["image-model"] ? "native-generated" : "pro-generated";
    const filename = join(output, `${stem}.${extension}`);
    await copyFile(localFiles.resolvePath(file.chatFilePath).absolutePath, filename);
    report.push({ check: edited ? "reference_edit" : "image_generation", modelRef, status: lastStatus, width: result.width, height: result.height, bytes: file.sizeBytes, mimeType: file.mimeType, assetPersisted: true, output: filename });
    console.log(JSON.stringify(report.at(-1))); return result.file_id as string;
  };
  if (!values["only-pro"]) {
    const reference = await generate(values["image-model"]);
    await generate(values["image-model"], true, reference);
  }
  await generate(values["pro-model"]);
  console.log(JSON.stringify({ passed: true, checks: report.length, elapsedMs: Date.now() - started }));
} finally {
  setFetchImplementationForTests(null);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await rm(temporary, { recursive: true, force: true });
}
