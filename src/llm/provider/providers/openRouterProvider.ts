import { requestSystemOne } from "../decision/systemOne.ts";
import type { LlmProvider, LlmProviderRequestContext } from "../providerTypes.ts";
import { OpenAiCompatibleProvider } from "./openAiCompatibleProvider.ts";

/** OpenRouter owns discovery and media protocols, and shares the compatible text transports. */
export class OpenRouterProvider implements LlmProvider {
  decide: NonNullable<LlmProvider["decide"]> = (context, params) => requestSystemOne(context, params);
  readonly type = "openrouter" as const;
  private readonly delegate = new OpenAiCompatibleProvider();
  resolveBaseUrl(config: LlmProviderRequestContext["providerConfig"]): string {
    return config.baseUrl?.trim() || "https://openrouter.ai/api/v1";
  }
  generate: LlmProvider["generate"] = (context, params) => this.delegate.generate(context, params);
  embed: NonNullable<LlmProvider["embed"]> = (context, params) => this.delegate.embed(context, params);
}
