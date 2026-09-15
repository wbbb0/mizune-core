import test from "node:test";
import assert from "node:assert/strict";
import { llmCatalogFileSchema } from "#config/configModel.ts";
import { normalizeLlmCatalog } from "#llm/shared/modelTarget.ts";
import { getProviderFeatureFromContext } from "#llm/provider/providerFeatures.ts";
import { createLlmTestConfig } from "../helpers/llm-test-support.tsx";

const meta = llmCatalogFileSchema.toMeta() as any;
const branch = (type: string) => meta.value.options.find((option: any) => option.fields.type.schema.value === type);

test("provider catalog exports discriminated options and only applicable controls", () => {
  assert.equal(meta.value.discriminator, "type");
  assert.equal(branch("deepseek").fields.features, undefined);
  assert.equal(branch("deepseek").fields.search.schema.fields.maxUses.schema.defaultValue, 3);
  assert.equal(branch("deepseek").fields.harmBlockThreshold, undefined);
  assert.ok(branch("google").fields.harmBlockThreshold);
  assert.equal(branch("google").fields.features, undefined);
  assert.ok(branch("openai").fields.features);
  assert.equal(branch("anthropic").fields.models.schema.value.fields.supportsSearch, undefined);
  assert.equal(branch("lmstudio").fields.models.schema.value.fields.supportsSearch, undefined);
});

test("known provider native search requires only model permission", () => {
  for (const type of ["deepseek", "google", "vertex", "vertex_express", "dashscope", "openai_responses"] as const) {
    const catalog = llmCatalogFileSchema.parseFromObject({ demo: { type, ...(type === "vertex" ? { projectId: "test-project" } : {}), models: { flash: { upstreamModel: "flash", supportsSearch: true } } } });
    const normalized = normalizeLlmCatalog(catalog);
    const config = createLlmTestConfig();
    const context = { config, modelRef: "demo/flash", providerConfig: normalized.providers.demo!, modelProfile: normalized.models["demo/flash"]! } as any;
    const feature = getProviderFeatureFromContext(context, "search");
    assert.ok(feature, type);
    if (type === "deepseek") assert.deepEqual(feature, { type: "builtin_tool", tool: { type: "web_search_20250305", name: "web_search", max_uses: 3 } });
    context.modelProfile.supportsSearch = false;
    assert.equal(getProviderFeatureFromContext(context, "search"), null);
  }
});

test("provider catalog validates search settings and preserves shared model identity", () => {
  assert.throws(() => llmCatalogFileSchema.parseFromObject({ ds: { type: "deepseek", search: { maxUses: 0 } } }));
  assert.throws(() => llmCatalogFileSchema.parseFromObject({ ds: { type: "unknown" } }));
  const catalog = llmCatalogFileSchema.parseFromObject({ ds: { type: "deepseek", apiKey: "key", search: { maxUses: 7 }, models: { flash: { upstreamModel: "flash" } } } });
  const result = normalizeLlmCatalog(catalog);
  assert.equal(result.providers.ds!.apiKey, "key");
  assert.equal(result.providers.ds!.search.maxUses, 7);
  assert.equal(result.models["ds/flash"]!.provider, "ds");
  assert.equal(result.models["ds/flash"]!.supportsSearch, false);
});

test("Google safety thresholds stay provider-specific and survive normalization", () => {
  const catalog = llmCatalogFileSchema.parseFromObject({ google: { type: "google", harmBlockThreshold: "BLOCK_LOW_AND_ABOVE", models: {} } });
  assert.equal(normalizeLlmCatalog(catalog).providers.google!.harmBlockThreshold, "BLOCK_LOW_AND_ABOVE");
});
