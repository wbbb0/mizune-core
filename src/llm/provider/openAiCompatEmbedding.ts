import { estimateTokens } from "#conversation/session/tokenEstimator.ts";
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
  const settings = context.modelProfile.embedding;
  if (!settings) throw new Error("模型未配置向量用途");
  params.abortSignal?.throwIfAborted();
  const purpose = params.purpose ?? "document";
  const texts = settings.inputMode === "qwen3" && purpose === "query"
    ? params.texts.map((text) => `Instruct: ${settings.queryInstruction}\nQuery: ${text}`)
    : params.texts;
  if (settings.limits.maxInputTokens && texts.some(text => estimateTokens(text, context.config.conversation.historyCompression.tokenEstimation) > settings.limits.maxInputTokens!)) {
    throw new Error("向量输入的估算 token 数超过模型输入上限，请调整分块长度");
  }
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
        input: texts,
        encoding_format: "float",
        ...(settings.dimensions ? { dimensions: settings.dimensions } : {}),
        ...(settings.inputMode === "input_type" ? { input_type: purpose === "query" ? "search_query" : "search_document" } : {})
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
    if (settings.dimensions && vectors[0]?.length !== settings.dimensions) throw new Error("Embedding API 未返回请求的向量维度");
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

export function normalizeEmbeddingVectors(payload: OpenAiEmbeddingResponse, expectedCount: number): number[][] {
  const rows = payload.data;
  if (!Array.isArray(rows) || rows.length !== expectedCount) {
    throw new Error(`Embedding API returned ${rows?.length ?? 0} vectors, expected ${expectedCount}`);
  }
  const vectors: number[][] = new Array(expectedCount);
  let dimension: number | undefined;
  for (const row of rows) {
    const index = row.index;
    if (!Number.isInteger(index) || index! < 0 || index! >= expectedCount || vectors[index!]) {
      throw new Error("Embedding API returned invalid or duplicate vector indices");
    }
    if (!Array.isArray(row.embedding) || row.embedding.length === 0 || row.embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error(`Embedding API returned invalid vector at index ${index}`);
    }
    dimension ??= row.embedding.length;
    if (row.embedding.length !== dimension) throw new Error("Embedding API returned inconsistent vector dimensions");
    vectors[index!] = row.embedding;
  }
  return vectors;
}
