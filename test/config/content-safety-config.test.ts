import assert from "node:assert/strict";
import { test } from "node:test";
import { contentSafetyConfigSchema, contentSafetyProviderConfigSchema } from "../../src/config/contentSafetyConfig.ts";
import { exportSchemaMeta, parseConfig } from "../../src/data/schema/index.ts";

test("content safety provider selector exposes separate Alibaba and OpenAI configuration branches", () => {
  const meta = exportSchemaMeta(contentSafetyProviderConfigSchema);
  assert.equal(meta.kind, "union");
  if (meta.kind !== "union") throw new Error("expected union");
  assert.equal(meta.discriminator, "type");
  const openai = meta.options.find(option => option.title === "OpenAI 内容安全");
  const aliyun = meta.options.find(option => option.title === "阿里云内容安全");
  assert.ok(openai?.kind === "object" && aliyun?.kind === "object");
  assert.ok(openai.fields.model && openai.fields.apiKey);
  assert.equal(openai.fields.accessKeyId, undefined);
  assert.equal(openai.fields.services, undefined);
  assert.ok(aliyun.fields.accessKeyId && aliyun.fields.services);
  assert.equal(aliyun.fields.apiKey, undefined);
  assert.equal(aliyun.fields.model, undefined);
  const safety = exportSchemaMeta(contentSafetyConfigSchema);
  assert.equal(safety.kind, "object");
  if (safety.kind !== "object") throw new Error("expected object");
  assert.equal(safety.fields.defaultProvider?.schema.kind, "string");
  assert.equal((safety.fields.defaultProvider?.schema as { dynamicRef?: string }).dynamicRef, "content_safety_provider_names");
});

test("provider defaults and parsing retain only the selected protocol's configuration", () => {
  const openai = parseConfig(contentSafetyProviderConfigSchema, { type: "openai_moderation", accessKeyId: "unused", services: { text: "unused" } });
  assert.equal(openai.type, "openai_moderation");
  if (openai.type !== "openai_moderation") throw new Error("unexpected provider");
  assert.equal(openai.model, "omni-moderation-latest");
  assert.equal(openai.baseUrl, "https://api.openai.com/v1");
  assert.equal(openai.apiKeyEnv, "OPENAI_API_KEY");
  assert.equal("accessKeyId" in openai, false);
  assert.equal("services" in openai, false);
  const aliyun = parseConfig(contentSafetyProviderConfigSchema, { type: "aliyun_content_moderation", model: "unused", apiKey: "unused" });
  assert.equal("model" in aliyun, false);
  assert.equal("apiKey" in aliyun, false);
  assert.throws(() => parseConfig(contentSafetyProviderConfigSchema, { type: "dashscope_data_inspection" }));
  assert.equal(parseConfig(contentSafetyConfigSchema, {}).enabled, false);
});
