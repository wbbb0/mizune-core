import test from "node:test";
import assert from "node:assert/strict";
import { parseDiscoveredModels, fillMissingModelFields } from "#llm/provider/modelDiscoveryMetadata.ts";
import { stageProviderModels, listProviderModelSlots } from "#llm/provider/modelListDiscovery.ts";
import { llmCatalogProviderFileSchema } from "#config/configModel.ts";
import { setFetchImplementationForTests } from "#services/proxy/index.ts";
import { createTestAppConfig } from "../../helpers/config-fixtures.tsx";

test("通用清单不根据模型名猜测用途，多模态元信息允许多个用途", () => {
  assert.deepEqual(parseDiscoveredModels({ data: [{ id: "text-embedding-image-chat" }] }, "test", "generic")[0]?.profile, {});
  const [model] = parseDiscoveredModels({ data: [{ id: "multi", architecture: { output_modalities: ["text", "embeddings"], input_modalities: ["text", "image"] }, context_length: 32768, supported_parameters: ["tools", "reasoning"], reasoning: { mandatory: true } }] }, "test", "generic");
  assert.ok(model?.profile.embedding);
  assert.deepEqual((model?.profile.chat as any).limits, { contextTokens: 32768 });
  assert.equal((model?.profile.chat as any).capabilities.thinkingControllable, false);
  assert.equal(model?.profile.image, undefined);
  assert.equal((model?.profile.chat as any).searchEnabled, undefined);
});

test("发现只填缺失字段，不覆盖 false、零、数组或手动默认参数", () => {
  const existing = { chat: { capabilities: { supportsTools: false }, defaults: { temperature: 0 }, limits: { contextTokens: 4096 } }, image: { constraints: { sizes: ["manual"] } } };
  const discovered = { chat: { capabilities: { supportsTools: true, supportsVision: true }, defaults: { temperature: 0.5 }, limits: { contextTokens: 8192 } }, image: { constraints: { sizes: ["remote"] } } };
  assert.deepEqual(fillMissingModelFields(existing, discovered), { ...existing, chat: { ...existing.chat, capabilities: { supportsTools: false, supportsVision: true } } });
  const slots = stageProviderModels([{ id: "multi", profile: discovered, source: "chat" }, { id: "multi", profile: { embedding: {} }, source: "embedding" }], { alias: { upstreamModel: "multi", ...existing } });
  assert.equal(slots.length, 1);
  assert.deepEqual(slots[0]?.sources, ["chat", "embedding"]);
  assert.equal(slots[0]?.alias, "alias");
  assert.ok(slots[0]?.profile.embedding);
});

test("专属清单解析尺寸、Google 分页模型信息及本地加载限制", () => {
  const [image] = parseDiscoveredModels({ data: [{ id: "image", supported_parameters: { resolution: { type: "enum", values: ["1K", "2K"] } }, supports_streaming: false }] }, "test", "image");
  assert.deepEqual((image?.profile.image as any).constraints, { resolutions: ["1K", "2K"] });
  const [google] = parseDiscoveredModels({ models: [{ name: "models/gemini", supportedGenerationMethods: ["generateContent"], inputTokenLimit: 1000, outputTokenLimit: 100 }] }, "test", "google");
  assert.equal(google?.id, "gemini");
  assert.deepEqual((google?.profile.chat as any).limits, { maxInputTokens: 1000, maxOutputTokens: 100 });
  const [local] = parseDiscoveredModels({ models: [{ key: "local", type: "llm", max_context_length: 32768, loaded_instances: [{ config: { context_length: 4096 } }] }] }, "test", "lmstudio");
  assert.equal((local?.profile.chat as any).limits.contextTokens, 4096);
});

test("OpenRouter 并行发现部分失败仍返回向量和聊天模型", async () => {
  const urls: string[] = [];
  setFetchImplementationForTests(async url => {
    const endpoint = String(url); urls.push(endpoint);
    if (endpoint.endsWith("/images/models")) return new Response("unavailable", { status: 503 });
    return new Response(JSON.stringify({ data: [{ id: endpoint.endsWith("/embeddings/models") ? "qwen/qwen3-embedding-8b" : "chat" }] }));
  });
  try {
    const result = await listProviderModelSlots({ provider: llmCatalogProviderFileSchema.parseFromObject({ type: "openrouter", models: {} }), config: createTestAppConfig() });
    assert.equal(result.kind, "ok");
    if (result.kind !== "ok") return;
    assert.equal(urls.length, 3);
    assert.equal(result.warnings.length, 1);
    assert.ok(result.models.find(model => model.upstreamModel === "qwen/qwen3-embedding-8b")?.profile.embedding);
  } finally { setFetchImplementationForTests(null); }
});
