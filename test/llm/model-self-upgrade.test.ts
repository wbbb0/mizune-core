import test from "node:test";
import assert from "node:assert/strict";
import type { AppConfig } from "../../src/config/config.ts";
import { getBuiltinToolNames, getBuiltinTools } from "../../src/llm/builtinTools.ts";
import {
  MODEL_SELF_UPGRADE_TOOL_NAME,
  resolveModelSelfUpgradePlan
} from "../../src/llm/shared/modelSelfUpgrade.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

test("model self-upgrade requires every route candidate to use one provider", () => {
  const config = createUpgradeConfig();
  const plan = resolveModelSelfUpgradePlan({
    config,
    currentModelRefs: ["small", "small_fallback"],
    enabled: true
  });

  assert.deepEqual(plan, {
    fromRole: "main_small",
    toRole: "main_large",
    smallModelRefs: ["small", "small_fallback"],
    largeModelRefs: ["large", "large_fallback"],
    provider: "test"
  });
});

test("model self-upgrade fails closed for cross-provider fallback candidates", () => {
  const config = createUpgradeConfig();
  config.llm.models.large_fallback!.provider = "other";

  assert.equal(resolveModelSelfUpgradePlan({
    config,
    currentModelRefs: ["small", "small_fallback"],
    enabled: true
  }), null);
});

test("model self-upgrade is hidden when disabled, already on large, same actual model, or tools unsupported", () => {
  const config = createUpgradeConfig();
  assert.equal(resolveModelSelfUpgradePlan({
    config,
    currentModelRefs: ["small", "small_fallback"],
    enabled: false
  }), null);
  assert.equal(resolveModelSelfUpgradePlan({
    config,
    currentModelRefs: ["large", "large_fallback"],
    enabled: true
  }), null);

  config.llm.models.large!.model = config.llm.models.small!.model;
  assert.equal(resolveModelSelfUpgradePlan({
    config,
    currentModelRefs: ["small", "small_fallback"],
    enabled: true
  }), null);

  config.llm.models.large!.model = "large-model";
  config.llm.models.small_fallback!.supportsTools = false;
  assert.equal(resolveModelSelfUpgradePlan({
    config,
    currentModelRefs: ["small", "small_fallback"],
    enabled: true
  }), null);
});

test("model self-upgrade tool requires explicit per-turn visibility", () => {
  const config = createUpgradeConfig();
  const baseOptions = {
    modelRef: ["small", "small_fallback"],
    availableToolNames: [MODEL_SELF_UPGRADE_TOOL_NAME]
  };

  assert.deepEqual(getBuiltinToolNames("known", null, config, {
    ...baseOptions,
    visibilityContext: { modelSelfUpgradeAvailable: false }
  }), []);
  assert.deepEqual(getBuiltinToolNames("known", null, config, {
    ...baseOptions,
    visibilityContext: { modelSelfUpgradeAvailable: true }
  }), [MODEL_SELF_UPGRADE_TOOL_NAME]);
});

test("model self-upgrade descriptor separates model capability from missing resources", () => {
  const config = createUpgradeConfig();
  const [tool] = getBuiltinTools("known", null, config, {
    modelRef: ["small", "small_fallback"],
    availableToolNames: [MODEL_SELF_UPGRADE_TOOL_NAME],
    visibilityContext: { modelSelfUpgradeAvailable: true }
  });
  const parameters = tool?.function.parameters as {
    properties?: { reason?: { description?: string } };
  };

  assert.match(tool?.function.description ?? "", /任务本身或新证据已表明当前模型难以可靠处理/);
  assert.match(tool?.function.description ?? "", /不能补充工具、权限或外部事实/);
  assert.match(
    parameters.properties?.reason?.description ?? "",
    /已知任务要求或新证据暴露的复杂性/
  );
});

function createUpgradeConfig(): AppConfig {
  const chatProfile = {
    provider: "test",
    modelType: "chat" as const,
    supportsThinking: true,
    thinkingControllable: true,
    supportsVision: false,
    supportsAudioInput: false,
    supportsSearch: false,
    supportsTools: true,
    preserveThinking: false
  };
  return createTestAppConfig({
    llm: {
      enabled: true,
      routingPreset: "upgrade",
      providers: {
        other: {
          type: "openai",
          baseUrl: "https://other.example.com/v1",
          apiKey: "test-key",
          proxy: false
        }
      },
      models: {
        small: { ...chatProfile, model: "small-model" },
        small_fallback: { ...chatProfile, model: "small-fallback-model" },
        large: { ...chatProfile, model: "large-model" },
        large_fallback: { ...chatProfile, model: "large-fallback-model" }
      },
      routingPresets: {
        upgrade: {
          mainSmall: ["small", "small_fallback"],
          mainLarge: ["large", "large_fallback"]
        }
      }
    }
  });
}
