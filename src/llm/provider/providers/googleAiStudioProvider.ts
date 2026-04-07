import type { LlmProviderRequestContext } from "../providerTypes.ts";
import {
  buildGoogleAiStudioStreamEndpoint,
  GoogleGeminiProviderBase
} from "./googleGeminiProviderBase.ts";

export class GoogleAiStudioProvider extends GoogleGeminiProviderBase {
  readonly type = "google" as const;
  protected readonly providerLabel = "Google AI Studio";

  protected getDefaultBaseUrl(): string | null {
    return "https://generativelanguage.googleapis.com/v1beta";
  }

  protected buildStreamEndpoint(context: LlmProviderRequestContext): string {
    return buildGoogleAiStudioStreamEndpoint(context.baseUrl, context.model);
  }

  protected buildHeaders(context: LlmProviderRequestContext): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-goog-api-key": context.providerConfig.apiKey ?? ""
    };
  }
}
