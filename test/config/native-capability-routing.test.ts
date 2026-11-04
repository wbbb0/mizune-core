import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadConfig } from "../../src/config/config.ts";
import { getModelRefsForRole } from "../../src/llm/shared/modelRouting.ts";
import { normalizeRoutingPresetTargetCatalog } from "../../src/llm/shared/modelTarget.ts";
import { applyLlmCatalogProviderMutations } from "../../src/config/llmCatalogMutations.ts";
import { llmRoutingPresetCatalogFileSchema } from "../../src/config/configModel.ts";
import { withConfigDir, writeDefaultInstanceYaml, writeYaml } from "../helpers/config-test-support.tsx";

test("持久化语音和决策路由经 YAML 加载保留联合模型身份与继承", async () => {
  await withConfigDir("native-route-yaml", async configDir => {
    await writeDefaultInstanceYaml(configDir);
    await writeYaml(join(configDir, "global.yml"), { llm: { enabled: true, routingPreset: "active" } });
    await writeYaml(join(configDir, "llm.catalog.yml"), {
      official: { type: "openai", apiKey: "test-only", models: { voice: { upstreamModel: "speech-model", speech: {} }, judge: { upstreamModel: "decision-model", decision: {} } } }
    });
    await writeYaml(join(configDir, "llm.routing-presets.yml"), {
      default: { speechGenerator: [{ provider: "official", model: "voice" }], decision: [{ provider: "official", model: "judge" }] },
      active: {}
    });
    const config = loadConfig({ CONFIG_DIR: configDir });
    assert.deepEqual(getModelRefsForRole(config, "speech_generator"), ["official/voice"]);
    assert.deepEqual(getModelRefsForRole(config, "decision"), ["official/judge"]);
    assert.equal(config.llm.models["official/voice"]!.speech!.voice, "alloy");
  });
});

test("目录重命名和删除一致更新新增路由，显式空列表保留禁用语义", () => {
  const routes = llmRoutingPresetCatalogFileSchema.parseFromObject({
    default: { speechGenerator: [{ provider: "old", model: "voice" }], decision: [{ provider: "old", model: "judge" }] },
    disabled: { speechGenerator: [], decision: [] }
  });
  const renamed = applyLlmCatalogProviderMutations(routes, [{ kind: "rename_provider", provider: "old", nextProvider: "official" }]);
  const normalized = normalizeRoutingPresetTargetCatalog(renamed);
  assert.deepEqual(normalized.default!.speechGenerator, ["official/voice"]);
  assert.deepEqual(normalized.default!.decision, ["official/judge"]);
  assert.deepEqual(normalized.disabled!.speechGenerator, []);
  assert.deepEqual(normalized.disabled!.decision, []);
  const deleted = applyLlmCatalogProviderMutations(renamed, [{ kind: "delete_provider", provider: "official" }]);
  assert.deepEqual(normalizeRoutingPresetTargetCatalog(deleted).default!.speechGenerator, []);
  assert.deepEqual(normalizeRoutingPresetTargetCatalog(deleted).default!.decision, []);
});
