import test from "node:test";
import assert from "node:assert/strict";
import {
  createProviderModelCapabilityDraft,
  resolveProviderModelListEndpoint,
  slugifyModelAlias,
  stageProviderModels
} from "#llm/provider/modelListDiscovery.ts";
import type { LlmProviderType } from "#config/llmProviderDefinitions.ts";

test("slugifyModelAlias produces [a-z0-9_] ids from upstream model names", () => {
  const cases: Array<[string, string]> = [
    ["gpt-4o", "gpt_4o"],
    ["GPT-4o", "gpt_4o"],
    ["claude-3-5-sonnet-20241022", "claude_3_5_sonnet_20241022"],
    ["text-embedding-v4", "text_embedding_v4"],
    ["accounts/fireworks/models/x", "accounts_fireworks_models_x"],
    ["  qwen3.5-plus  ", "qwen3_5_plus"],
    ["...", "model"],
    ["", "model"]
  ];
  for (const [input, expected] of cases) {
    assert.equal(slugifyModelAlias(input), expected);
  }
});

test("capability draft only includes supportsSearch when provider protocol supports search", () => {
  const withSearch = createProviderModelCapabilityDraft("openai");
  assert.equal(withSearch.supportsSearch, false);
  assert.equal(withSearch.modelType, "chat");
  assert.equal(withSearch.supportsThinking, false);
  assert.equal(withSearch.supportsVision, false);
  assert.equal(withSearch.supportsTools, true);

  const nativeSearch = createProviderModelCapabilityDraft("deepseek");
  assert.ok("supportsSearch" in nativeSearch);

  const noSearch = createProviderModelCapabilityDraft("lmstudio");
  assert.equal("supportsSearch" in noSearch, false);
  const anthropic = createProviderModelCapabilityDraft("anthropic");
  assert.equal("supportsSearch" in anthropic, false);
});

test("model list endpoint resolves per provider type with defaults", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ type: "openai" }, "https://api.openai.com/v1/models"],
    [{ type: "openai_responses" }, "https://api.openai.com/v1/models"],
    [{ type: "deepseek" }, "https://api.deepseek.com/models"],
    [{ type: "lmstudio" }, "http://localhost:1234/v1/models"],
    [{ type: "anthropic" }, "https://api.anthropic.com/v1/models?limit=1000"],
    [{ type: "openai", baseUrl: "https://proxy.example.com/v1" }, "https://proxy.example.com/v1/models"]
  ];
  for (const [provider, expected] of cases) {
    const resolved = resolveProviderModelListEndpoint(provider as { type: LlmProviderType; baseUrl?: string });
    assert.deepEqual(resolved, { endpoint: expected });
  }
});

test("dashscope endpoint rewrites the native base to compatible-mode models", () => {
  const defaultBase = resolveProviderModelListEndpoint({ type: "dashscope" });
  assert.deepEqual(defaultBase, {
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/models"
  });
  const compatibleBase = resolveProviderModelListEndpoint({
    type: "dashscope",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1"
  });
  assert.deepEqual(compatibleBase, {
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/models"
  });
});

test("unsupported provider types are reported instead of guessing an endpoint", () => {
  const resolved = resolveProviderModelListEndpoint({ type: "vertex" });
  assert.ok("unsupported" in resolved);
  if ("unsupported" in resolved) {
    assert.match(resolved.reason, /暂不支持/);
  }
});

test("stageProviderModels keeps existing aliases for known upstream models", () => {
  const existing = {
    main: { upstreamModel: "deepseek-chat" },
    fast: { upstreamModel: "deepseek-reasoner" }
  };
  const slots = stageProviderModels(
    ["deepseek-chat", "deepseek-reasoner", "deepseek-coder"],
    "deepseek",
    existing
  );
  assert.deepEqual(slots.map(s => s.upstreamModel), ["deepseek-chat", "deepseek-reasoner", "deepseek-coder"]);
  const [chat, reasoner, coder] = slots;
  assert.ok(chat && reasoner && coder);
  assert.equal(chat.alias, "main");
  assert.equal(chat.exists, true);
  assert.equal(reasoner.alias, "fast");
  assert.equal(reasoner.exists, true);
  assert.equal(coder.alias, "deepseek_coder");
  assert.equal(coder.exists, false);
});

test("stageProviderModels inherits existing capability values on re-import instead of resetting", () => {
  const existing = {
    main: {
      upstreamModel: "gpt-4o",
      modelType: "chat",
      supportsThinking: true,
      supportsVision: true,
      supportsSearch: true,
      supportsTools: false
    }
  };
  const [slot] = stageProviderModels(["gpt-4o", "gpt-5.6"], "openai", existing);
  assert.ok(slot);
  assert.equal(slot.exists, true);
  assert.equal(slot.capabilities.modelType, "chat");
  assert.equal(slot.capabilities.supportsThinking, true);
  assert.equal(slot.capabilities.supportsVision, true);
  assert.equal(slot.capabilities.supportsSearch, true);
  assert.equal(slot.capabilities.supportsTools, false);
});

test("deepseek model list endpoint normalizes an anthropic-compat base to the OpenAI root", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ type: "deepseek" }, "https://api.deepseek.com/models"],
    [{ type: "deepseek", baseUrl: "https://api.deepseek.com/anthropic" }, "https://api.deepseek.com/models"],
    [{ type: "deepseek", baseUrl: "https://proxy.example.com/deepseek/anthropic/" }, "https://proxy.example.com/deepseek/models"]
  ];
  for (const [provider, expected] of cases) {
    const resolved = resolveProviderModelListEndpoint(provider as { type: LlmProviderType; baseUrl?: string });
    assert.deepEqual(resolved, { endpoint: expected });
  }
});

test("anthropic model list endpoint requests a full page via limit", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ type: "anthropic" }, "https://api.anthropic.com/v1/models?limit=1000"],
    [{ type: "anthropic", baseUrl: "https://proxy.example.com/anthropic" }, "https://proxy.example.com/anthropic/v1/models?limit=1000"]
  ];
  for (const [provider, expected] of cases) {
    const resolved = resolveProviderModelListEndpoint(provider as { type: LlmProviderType; baseUrl?: string });
    assert.deepEqual(resolved, { endpoint: expected });
  }
});

test("stageProviderModels uniquifies generated aliases against existing ones", () => {
  const existing = {
    gpt_4o: { upstreamModel: "gpt-4o-2024-05-13" }
  };
  const slots = stageProviderModels(["gpt-4o", "gpt-4o-mini"], "openai", existing);
  const [gpt4o, mini] = slots;
  assert.ok(gpt4o && mini);
  assert.equal(gpt4o.exists, false);
  assert.equal(gpt4o.alias, "gpt_4o_2");
  assert.equal(mini.alias, "gpt_4o_mini");
});

test("stageProviderModels dedupes repeated upstream ids within the fetched list", () => {
  const slots = stageProviderModels(["a", "a", "b"], "openai", {});
  assert.deepEqual(slots.map(s => s.upstreamModel), ["a", "b"]);
});