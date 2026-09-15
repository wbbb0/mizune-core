import type { LlmProviderRequestContext } from "../providerTypes.ts";
import {
  buildVertexAiStreamEndpoint,
  formatBearerAuthorization,
  GoogleGeminiProviderBase
} from "./googleGeminiProviderBase.ts";

export class VertexAiProvider extends GoogleGeminiProviderBase {
  readonly type = "vertex" as const;
  protected readonly providerLabel = "Vertex AI";

  override resolveBaseUrl(providerConfig: LlmProviderRequestContext["providerConfig"]): string | null {
    if (providerConfig.baseUrl?.trim()) return providerConfig.baseUrl.trim();
    if (!providerConfig.projectId) return null;
    const location = providerConfig.location;
    const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
    return `https://${host}/v1/projects/${encodeURIComponent(providerConfig.projectId)}/locations/${encodeURIComponent(location)}/publishers/google`;
  }

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
