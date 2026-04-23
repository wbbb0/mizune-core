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
  return providerConfig?.features[featureName] ?? null;
}

export function getProviderFeatureFromContext(
  context: LlmProviderRequestContext,
  featureName: ProviderFeatureName
): ProviderFeatureConfig | null {
  if (!isFeatureSupportedByModel(context.modelProfile, featureName)) {
    return null;
  }
  return context.providerConfig.features[featureName] ?? null;
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
