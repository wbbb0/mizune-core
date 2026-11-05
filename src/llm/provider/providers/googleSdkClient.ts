import { ApiError, GoogleGenAI } from "@google/genai";
import type { AppConfig } from "#config/config.ts";
import { fetchProviderResponse } from "../providerExchangeDump.ts";
import { LlmProviderHttpError } from "../providerProtocolError.ts";
import { attachRequestDiagnostic, getRequestDiagnostic } from "../requestDiagnostics.ts";

export { resolveAiStudioEndpoint } from "./googleEndpoint.ts";
import { resolveAiStudioEndpoint } from "./googleEndpoint.ts";

export function normalizeGoogleSdkError(error: unknown): unknown {
  if (!(error instanceof ApiError)) return error;
  const wrapped = new LlmProviderHttpError(error.status, `Google AI Studio API error: ${error.status} ${error.message}`);
  Object.defineProperty(wrapped, "cause", { value: error });
  const diagnostic = getRequestDiagnostic(error);
  if (diagnostic) attachRequestDiagnostic(wrapped, diagnostic);
  return wrapped;
}

export function createAiStudioClient(input: {
  config: AppConfig; apiKey?: string | undefined; baseUrl?: string | undefined; providerProxy?: boolean | undefined; modelRef?: string | undefined; onResponse?: (response: Response) => void;
}) {
  const apiKey = input.apiKey?.trim();
  if (!apiKey) throw new Error("Google AI Studio API Key 未配置");
  const endpoint = resolveAiStudioEndpoint(input.baseUrl);
  return new GoogleGenAI({
    vertexai: false,
    apiKey,
    httpOptions: {
      ...endpoint,
      retryOptions: { attempts: 1 },
      // No SDK timeout: the operation owns its abort signal and all timers.
      fetch: async (url, init) => {
        if (typeof url !== "string" && !(url instanceof URL)) throw new Error("AI Studio SDK 请求必须提供 URL");
        if (init?.body != null && typeof init.body !== "string") throw new Error("AI Studio 当前仅支持 JSON 请求体");
        const response = await fetchProviderResponse(input.config, "llm", String(url), {
          ...(init?.method ? { method: init.method } : {}),
          ...(typeof init?.body === "string" ? { body: init.body } : {}),
          ...(init?.signal ? { signal: init.signal } : {}),
          headers: Object.fromEntries(new Headers(init?.headers))
        }, {
          ...(input.modelRef ? { modelRef: input.modelRef } : {}),
          ...(input.providerProxy !== undefined ? { providerProxy: input.providerProxy } : {})
        });
        input.onResponse?.(response as unknown as Response);
        return response as unknown as Response;
      }
    }
  });
}
