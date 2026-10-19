import type { LlmProviderRequestContext } from "./providerTypes.ts";

export function getGenerationSettings(context: LlmProviderRequestContext) {
  return context.modelProfile[context.operation ?? "chat"];
}
