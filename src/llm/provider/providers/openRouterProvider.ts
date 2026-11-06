import { fetchNativeProviderModels, resolveProviderModelListEndpoint } from "../nativeModelDiscovery.ts";
import type { ModelDiscoveryInput, NativeModelDiscoveryResult } from "../modelDiscoveryTypes.ts";
import { LlmProviderBase } from "../llmProviderBase.ts";
import { requestSystemOne } from "../decision/systemOne.ts";
import type { LlmProvider, LlmProviderRequestContext } from "../providerTypes.ts";
import { OpenAiCompatibleProvider } from "./openAiCompatibleProvider.ts";

/** OpenRouter owns discovery and media protocols, and shares the compatible text transports. */
export class OpenRouterProvider extends LlmProviderBase {
  protected override discoverNativeModels(input: ModelDiscoveryInput): Promise<NativeModelDiscoveryResult> {
    const resolved = resolveProviderModelListEndpoint(input.provider);
    if ("unsupported" in resolved) return super.discoverNativeModels(input);
    const base = resolved.endpoint.replace(/\/models$/, "");
    return fetchNativeProviderModels(input, [
      { endpoint: resolved.endpoint, kind: "chat" },
      { endpoint: `${base}/embeddings/models`, kind: "embedding" },
      { endpoint: `${base}/images/models`, kind: "image" }
    ]);
  }
  decide: NonNullable<LlmProvider["decide"]> = (context, params) => requestSystemOne(context, params);
  readonly type = "openrouter" as const;
  private readonly delegate = new OpenAiCompatibleProvider();
  resolveBaseUrl(config: LlmProviderRequestContext["providerConfig"]): string {
    return config.baseUrl?.trim() || "https://openrouter.ai/api/v1";
  }
  generate: LlmProvider["generate"] = (context, params) => this.delegate.generate(context, params);
  embed: NonNullable<LlmProvider["embed"]> = (context, params) => this.delegate.embed(context, params);
}
