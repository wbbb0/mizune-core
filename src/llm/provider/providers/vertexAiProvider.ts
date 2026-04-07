import type { LlmProviderRequestContext } from "../providerTypes.ts";
import {
  buildVertexAiStreamEndpoint,
  formatBearerAuthorization,
  GoogleGeminiProviderBase
} from "./googleGeminiProviderBase.ts";

export class VertexAiProvider extends GoogleGeminiProviderBase {
  readonly type = "vertex" as const;
  protected readonly providerLabel = "Vertex AI";

  protected getDefaultBaseUrl(): string | null {
    return null;
  }

  protected buildStreamEndpoint(context: LlmProviderRequestContext): string {
    return buildVertexAiStreamEndpoint(context.baseUrl, context.model);
  }

  protected buildHeaders(context: LlmProviderRequestContext): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: formatBearerAuthorization(context.providerConfig.apiKey)
    };
  }
}
