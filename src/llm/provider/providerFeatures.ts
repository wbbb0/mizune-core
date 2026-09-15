import type { AppConfig } from "#config/config.ts";
import { getPrimaryModelProfile } from "#llm/shared/modelProfiles.ts";
import { getModelRefsForRole } from "#llm/shared/modelRouting.ts";
import type { LlmProviderConfig, ModelProfile } from "#config/configModel.ts";
import type { LlmProviderRequestContext } from "./providerTypes.ts";

export type ProviderFeatureName = "thinking" | "search";

type ProviderFeatureConfig = NonNullable<LlmProviderConfig["features"][ProviderFeatureName]>;

export function getProviderFeature(
  config: AppConfig,
  modelRef: string | string[],
  featureName: ProviderFeatureName
): ProviderFeatureConfig | null {
  const modelProfile = getPrimaryModelProfile(config, modelRef);
  if (!modelProfile || !isFeatureSupportedByModel(modelProfile, featureName)) {
    return null;
  }

  const providerConfig = config.llm.providers[modelProfile.provider];
  return providerConfig ? resolveProviderFeature(providerConfig, featureName) : null;
}

export function getProviderFeatureFromContext(
  context: LlmProviderRequestContext,
  featureName: ProviderFeatureName
): ProviderFeatureConfig | null {
  if (!isFeatureSupportedByModel(context.modelProfile, featureName)) {
    return null;
  }
  return resolveProviderFeature(context.providerConfig, featureName);
}

export function hasNativeSearchFeature(
  config: AppConfig,
  modelRef: string | string[] = getModelRefsForRole(config, "main_small")
): boolean {
  return getProviderFeature(config, modelRef, "search") != null;
}

function isFeatureSupportedByModel(modelProfile: ModelProfile, featureName: ProviderFeatureName): boolean {
  if (featureName === "thinking") {
    return modelProfile.supportsThinking && modelProfile.thinkingControllable;
  }
  return modelProfile.supportsSearch;
}

/** 用户只声明模型是否允许搜索；协议工具名称和字段由 provider 负责。 */
function resolveProviderFeature(provider: LlmProviderConfig, feature: ProviderFeatureName): ProviderFeatureConfig | null {
  if (["openai", "openai_responses", "lmstudio"].includes(provider.type)) {
    const override = provider.features[feature];
    if (override) return override;
  }
  if (feature === "thinking") {
    return provider.type === "dashscope" ? { type: "flag", path: "enable_thinking" } : null;
  }
  switch (provider.type) {
    case "deepseek": return { type: "builtin_tool", tool: { type: "web_search_20250305", name: "web_search", max_uses: provider.search.maxUses } };
    case "openai_responses": return { type: "builtin_tool", tool: { type: "web_search" } };
    case "google":
    case "vertex":
    case "vertex_express": return { type: "builtin_tool", tool: { googleSearch: {} } };
    case "dashscope": return { type: "flag", path: "enable_search" };
    default: return null;
  }
}
