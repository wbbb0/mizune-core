import type { AppConfig } from "#config/config.ts";
import { getModelRefsForRole } from "#llm/shared/modelRouting.ts";
import { getProviderFeature } from "./providerFeatures.ts";

export function getNativeSearchEnableKey(
  config: AppConfig,
  modelRef: string | string[] = getModelRefsForRole(config, "main_small")
): string | null {
  const searchFeature = getProviderFeature(config, modelRef, "search");
  if (!searchFeature || searchFeature.type !== "flag") {
    return null;
  }
  return searchFeature.path;
}
