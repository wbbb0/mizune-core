import { fetchWithProxy } from "#services/proxy/index.ts";
import { createProviderTimeoutController, rethrowProviderAbortReason } from "./providerTimeout.ts";
import {
  createEmptyUsage,
  numberOrNull,
  type LlmEmbeddingParams,
  type LlmEmbeddingResult,
  type LlmProviderRequestContext
} from "./providerTypes.ts";

interface OpenAiEmbeddingResponse {
  data?: Array<{
    index?: number;
    embedding?: unknown;
  }>;
  usage?: {
    prompt_tokens?: number;
    total_tokens?: number;
  };
}

export async function requestOpenAiCompatibleEmbeddings(
  context: LlmProviderRequestContext,
  params: LlmEmbeddingParams,
  options?: {
    endpointBaseUrl?: string;
    apiKey?: string;
  }
): Promise<LlmEmbeddingResult> {
  const endpointBaseUrl = options?.endpointBaseUrl ?? context.baseUrl;
  const endpoint = `${endpointBaseUrl.replace(/\/$/, "")}/embeddings`;
  const resolvedTimeoutMs = params.timeoutMsOverride ?? context.config.context.embedding.timeoutMs;
  const timeoutController = createProviderTimeoutController({
    totalTimeoutMs: resolvedTimeoutMs,
    firstTokenTimeoutMs: resolvedTimeoutMs
  });
  timeoutController.markFirstResponseReceived();
  const forwardAbort = () => timeoutController.controller.abort();
  params.abortSignal?.addEventListener("abort", forwardAbort, { once: true });

  try {
    const response = await fetchWithProxy(context.config, "llm", endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options?.apiKey ?? context.providerConfig.apiKey ?? ""}`
      },
      body: JSON.stringify({
        model: context.model,
        input: params.texts
      }),
      signal: timeoutController.controller.signal
    }, {
      modelRef: context.modelRef
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Embedding API error: ${response.status} ${response.statusText}${errorText ? ` ${errorText}` : ""}`);
    }

    const payload = await response.json() as OpenAiEmbeddingResponse;
    const vectors = normalizeEmbeddingVectors(payload, params.texts.length);
    return {
      vectors,
      usage: {
        ...createEmptyUsage(context.modelRef, context.model),
        inputTokens: numberOrNull(payload.usage?.prompt_tokens),
        totalTokens: numberOrNull(payload.usage?.total_tokens),
        requestCount: 1,
        providerReported: payload.usage != null
      }
    };
  } catch (error) {
    rethrowProviderAbortReason(timeoutController.controller.signal, error);
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    params.abortSignal?.removeEventListener("abort", forwardAbort);
    timeoutController.cleanup();
  }
}

function normalizeEmbeddingVectors(payload: OpenAiEmbeddingResponse, expectedCount: number): number[][] {
  const rows = [...(payload.data ?? [])].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
  if (rows.length !== expectedCount) {
    throw new Error(`Embedding API returned ${rows.length} vectors, expected ${expectedCount}`);
  }
  return rows.map((row, index) => {
    if (!Array.isArray(row.embedding) || row.embedding.length === 0) {
      throw new Error(`Embedding API returned empty vector at index ${index}`);
    }
    return row.embedding.map((value) => {
      const numberValue = Number(value);
      if (!Number.isFinite(numberValue)) {
        throw new Error(`Embedding API returned non-numeric vector value at index ${index}`);
      }
      return numberValue;
    });
  });
}
