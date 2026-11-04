import { LlmProviderHttpError } from "./providerProtocolError.ts";
import { fetchProviderResponse } from "./providerExchangeDump.ts";
import { createEmptyUsage, numberOrNull, type LlmProviderRequestContext, type LlmUsage } from "./providerTypes.ts";
import type { NativeCapabilityParams } from "./nativeCapabilityTypes.ts";
import type { RequestInit, Response } from "undici";

/** Bounded native endpoint request; caller owns retry policy and provider selection. */
export async function requestNativeCapability<T>(
  context: LlmProviderRequestContext,
  params: NativeCapabilityParams,
  path: string,
  request: Pick<RequestInit, "body" | "headers">,
  parse: (response: Response) => Promise<T>
): Promise<T> {
  if (context.providerConfig.type !== "openai") throw new Error("此原生能力仅支持 OpenAI 官方供应商");
  params.abortSignal?.throwIfAborted();
  const signal = AbortSignal.any([
    AbortSignal.timeout(params.timeoutMsOverride ?? context.config.llm.timeoutMs),
    ...(params.abortSignal ? [params.abortSignal] : [])
  ]);
  const response = await fetchProviderResponse(context.config, "llm", `${context.baseUrl.replace(/\/+$/, "")}${path}`, {
    method: "POST",
    ...request,
    headers: { ...request.headers, ...(context.providerConfig.apiKey ? { Authorization: `Bearer ${context.providerConfig.apiKey}` } : {}) },
    signal
  }, { modelRef: context.modelRef });
  try {
    if (!response.ok) {
      const detail = (await readNativeBody(response, 65536)).toString("utf8");
      throw new LlmProviderHttpError(response.status, `OpenAI ${path} HTTP ${response.status}: ${detail.slice(0, 4096)}`);
    }
    const result = await parse(response);
    signal.throwIfAborted();
    return result;
  } finally {
    await response.body?.cancel().catch(() => {});
  }
}

export async function readNativeBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new Error("OpenAI 接口响应超过大小限制");
  }
  if (!response.body) throw new Error("OpenAI 接口响应为空");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new Error("OpenAI 接口响应超过大小限制");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, length);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function nativeUsage(context: LlmProviderRequestContext, raw: unknown): LlmUsage {
  const usage = isObject(raw) ? raw : {};
  return {
    ...createEmptyUsage(context.modelRef, context.model),
    inputTokens: numberOrNull(usage.input_tokens),
    outputTokens: numberOrNull(usage.output_tokens),
    totalTokens: numberOrNull(usage.total_tokens),
    cachedTokens: isObject(usage.input_tokens_details) ? numberOrNull(usage.input_tokens_details.cached_tokens) : null,
    requestCount: 1,
    providerReported: Object.keys(usage).length > 0
  };
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
