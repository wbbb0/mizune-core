import test from "node:test";
import assert from "node:assert/strict";
import { llmCatalogFileSchema } from "#config/configModel.ts";
import { normalizeLlmCatalog } from "#llm/shared/modelTarget.ts";

test("Google 图像与向量配置只保留当前协议字段，默认前缀保留末尾空格", () => {
  const catalog = llmCatalogFileSchema.parse({ google: { type: "google", models: {
    image: { upstreamModel: "image-model", image: { defaults: { aspect_ratio: "16:9", resolution: "2K", size: "1024x1024", quality: "high", output_format: "png" } } },
    vector: { upstreamModel: "embedding-model", embedding: { inputMode: "task_prefix", dimensions: 768 } }
  } } });
  assert.deepEqual(catalog.google!.models.image!.image!.defaults, { aspect_ratio: "16:9", resolution: "2K" });
  const runtime = normalizeLlmCatalog(catalog);
  assert.equal(runtime.models["google/vector"]!.embedding!.queryPrefix, "task: search result | query: ");
  assert.equal(runtime.models["google/vector"]!.embedding!.documentPrefix, "title: none | text: ");
});

test("Google 与兼容接口的 embedding 模式相互隔离", () => {
  assert.throws(() => llmCatalogFileSchema.parse({ google: { type: "google", models: { vector: { upstreamModel: "vector", embedding: { inputMode: "qwen3" } } } } }));
  assert.throws(() => llmCatalogFileSchema.parse({ compat: { type: "openai_compatible", models: { vector: { upstreamModel: "vector", embedding: { inputMode: "task_prefix" } } } } }));
});
