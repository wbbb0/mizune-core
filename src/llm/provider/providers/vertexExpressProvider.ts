import type { LlmProviderRequestContext } from "../providerTypes.ts";
import {
  buildVertexExpressStreamEndpoint,
  GoogleGeminiProviderBase
} from "./googleGeminiProviderBase.ts";

export class VertexExpressProvider extends GoogleGeminiProviderBase {
  readonly type = "vertex_express" as const;
  protected readonly providerLabel = "Vertex AI Express";

  protected getDefaultBaseUrl(): string | null {
    return "https://aiplatform.googleapis.com/v1";
  }

  protected buildStreamEndpoint(context: LlmProviderRequestContext): string {
    return buildVertexExpressStreamEndpoint(context.baseUrl, context.model, context.providerConfig.apiKey);
  }

  protected buildHeaders(_context: LlmProviderRequestContext): Record<string, string> {
    return {
      "Content-Type": "application/json"
    };
  }
}
