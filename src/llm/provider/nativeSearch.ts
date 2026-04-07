import type { AppConfig } from "#config/config.ts";
import { getDefaultMainModelRefs } from "#llm/shared/modelProfiles.ts";
import { getProviderFeature } from "./providerFeatures.ts";

export function getNativeSearchEnableKey(
  config: AppConfig,
  modelRef: string | string[] = getDefaultMainModelRefs(config)
): string | null {
  const searchFeature = getProviderFeature(config, modelRef, "search");
  if (!searchFeature || searchFeature.type !== "flag") {
    return null;
  }
  return searchFeature.path;
}
