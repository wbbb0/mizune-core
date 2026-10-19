import type { LlmProvider, LlmProviderRequestContext } from "../providerTypes.ts";
import { OpenAiProvider } from "./openaiProvider.ts";

/** OpenRouter owns discovery and media protocols, and shares the compatible text transports. */
export class OpenRouterProvider implements LlmProvider {
  readonly type = "openrouter" as const;
  private readonly delegate = new OpenAiProvider();
  resolveBaseUrl(config: LlmProviderRequestContext["providerConfig"]): string {
    return config.baseUrl?.trim() || "https://openrouter.ai/api/v1";
  }
  generate: LlmProvider["generate"] = (context, params) => this.delegate.generate(context, params);
  embed: NonNullable<LlmProvider["embed"]> = (context, params) => this.delegate.embed(context, params);
}
