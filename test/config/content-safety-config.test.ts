import assert from "node:assert/strict";
import { test } from "node:test";
import { contentSafetyConfigSchema } from "../../src/config/contentSafetyConfig.ts";
import { exportSchemaMeta, parseConfig } from "../../src/data/schema/index.ts";
import { mergeConfigLayers } from "../../src/config/mergeConfigLayers.ts";

test("content safety has one outer provider selector and a matching inner configuration", () => {
  const meta = exportSchemaMeta(contentSafetyConfigSchema);
  assert.equal(meta.kind, "union");
  if (meta.kind !== "union") throw new Error("expected union");
  assert.equal(meta.discriminator, "provider");
  for (const variant of meta.options) {
    assert.equal(variant.kind, "object");
    if (variant.kind !== "object") throw new Error("expected object");
    assert.equal(variant.fields.providers, undefined);
    assert.equal(variant.fields.defaultProvider, undefined);
    const profiles = variant.fields.profiles!.schema;
    if (profiles.kind !== "record" || profiles.value.kind !== "object") throw new Error("expected profile record");
    const rule = profiles.value.fields.text!.schema;
    if (rule.kind !== "object") throw new Error("expected rule");
    assert.equal(rule.fields.provider, undefined);
  }
  const openai = meta.options.find(option => option.title === "OpenAI 内容安全");
  const aliyun = meta.options.find(option => option.title === "阿里云内容安全");
  assert.ok(openai?.kind === "object" && aliyun?.kind === "object");
  const openaiSettings = openai.fields.config!.schema;
  const aliyunSettings = aliyun.fields.config!.schema;
  assert.ok(openaiSettings.kind === "object" && aliyunSettings.kind === "object");
  assert.ok(openaiSettings.fields.model && openaiSettings.fields.apiKey);
  assert.equal(openaiSettings.fields.accessKeyId, undefined);
  assert.ok(aliyunSettings.fields.accessKeyId && aliyunSettings.fields.services);
  assert.equal(aliyunSettings.fields.apiKey, undefined);
});

test("provider defaults and parsing retain only the chosen provider's inner configuration", () => {
  const openai = parseConfig(contentSafetyConfigSchema, { provider: "openai", config: { accessKeyId: "unused", services: { text: "unused" } } });
  assert.equal(openai.provider, "openai");
  if (openai.provider !== "openai") throw new Error("unexpected provider");
  assert.equal(openai.config.model, "omni-moderation-latest");
  assert.equal(openai.config.baseUrl, "https://api.openai.com/v1");
  assert.equal(openai.config.apiKeyEnv, "OPENAI_API_KEY");
  assert.equal("accessKeyId" in openai.config, false);
  assert.equal("services" in openai.config, false);
  assert.throws(() => parseConfig(contentSafetyConfigSchema, { provider: "unknown" }));
  assert.equal(parseConfig(contentSafetyConfigSchema, {}).enabled, false);
});

test("instance provider selection applies to every rule without inherited supplier aliases", () => {
  const layers = mergeConfigLayers([
    { contentSafety: { provider: "aliyun", config: { accessKeyId: "ali", services: { text: "chat_detection" } }, profiles: { preLlm: { text: { action: "mark" } } } } },
    { contentSafety: { provider: "openai", config: { apiKey: "openai-key" } } }
  ]);
  const config = parseConfig(contentSafetyConfigSchema, layers.contentSafety);
  assert.equal(config.provider, "openai");
  assert.equal("accessKeyId" in config.config, false);
  assert.equal("services" in config.config, false);
  assert.equal(config.profiles.preLlm!.text.action, "mark");
});

test("switching provider replaces its settings, while same-provider overrides inherit credentials", () => {
  const same = mergeConfigLayers([
    { contentSafety: { provider: "openai", config: { apiKey: "global-key", model: "first-model", timeoutMs: 1000 } } },
    { contentSafety: { provider: "openai", config: { model: "second-model" } } }
  ]);
  assert.deepEqual((same.contentSafety as { config: unknown }).config, { apiKey: "global-key", model: "second-model", timeoutMs: 1000 });
  const switched = mergeConfigLayers([
    { contentSafety: { provider: "aliyun", config: { accessKeyId: "ali", timeoutMs: 1000 } } },
    { contentSafety: { provider: "openai" } }
  ]);
  assert.deepEqual((switched.contentSafety as { config: unknown }).config, {});
  const parsed = parseConfig(contentSafetyConfigSchema, switched.contentSafety);
  assert.equal(parsed.provider, "openai");
  if (parsed.provider !== "openai") throw new Error("unexpected provider");
  assert.equal(parsed.config.timeoutMs, 6000);
});

test("explicit default provider inherits credentials when the global layer omits its discriminator", () => {
  const merged = mergeConfigLayers([
    { contentSafety: { config: { accessKeyId: "inherited", timeoutMs: 12000 } } },
    { contentSafety: { provider: "aliyun" } }
  ]);
  assert.deepEqual((merged.contentSafety as { config: unknown }).config, { accessKeyId: "inherited", timeoutMs: 12000 });
});
