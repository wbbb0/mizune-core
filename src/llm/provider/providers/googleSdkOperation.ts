import type { GoogleGenAI } from "@google/genai";
import type { LlmProviderRequestContext } from "../providerTypes.ts";
import { createAiStudioClient, normalizeGoogleSdkError } from "./googleSdkClient.ts";

/** Unary operations share network/error ownership; their caller owns the deadline. */
export async function runAiStudioOperation<T>(
  input: Pick<LlmProviderRequestContext, "config" | "providerConfig" | "modelRef"> & { baseUrl?: string | undefined; signal: AbortSignal; maxResponseBytes: number },
  run: (client: GoogleGenAI, signal: AbortSignal) => Promise<T>
): Promise<T> {
  input.signal.throwIfAborted();
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, controller.signal]);
  const responses: Response[] = [];
  let completed = false;
  try {
    const client = createAiStudioClient({
      config: input.config, providerProxy: input.providerConfig.proxy, apiKey: input.providerConfig.apiKey,
      baseUrl: input.baseUrl, modelRef: input.modelRef, maxResponseBytes: input.maxResponseBytes,
      onResponse: response => responses.push(response)
    });
    const result = await run(client, signal);
    signal.throwIfAborted();
    completed = true;
    return result;
  } catch (error) {
    signal.throwIfAborted();
    throw normalizeGoogleSdkError(error);
  } finally {
    if (!completed) {
      controller.abort(new Error("Google 请求未完整完成"));
      await Promise.allSettled(responses.map(response => response.body?.cancel(signal.reason)));
    }
  }
}
