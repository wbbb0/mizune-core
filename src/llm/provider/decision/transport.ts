import { fetchProviderResponse } from "../providerExchangeDump.ts";
import { readNativeBody } from "../nativeCapabilityHttp.ts";
import { LlmProviderHttpError } from "../providerProtocolError.ts";
import type { LlmProviderRequestContext } from "../providerTypes.ts";
import type { LlmDecideParams } from "../nativeCapabilityTypes.ts";

export function decisionSignal(context: LlmProviderRequestContext, params: LlmDecideParams): AbortSignal {
  params.abortSignal?.throwIfAborted();
  return AbortSignal.any([AbortSignal.timeout(params.timeoutMsOverride ?? context.config.llm.timeoutMs), ...(params.abortSignal ? [params.abortSignal] : [])]);
}

/** SDKs retain protocol ownership; application transport owns proxy, bounded reads and HTTP errors. */
export function decisionFetch(context: LlmProviderRequestContext): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    const response = await fetchProviderResponse(context.config, "llm", request.url, {
      method: request.method, headers: Object.fromEntries(request.headers), body: await request.text(), signal: request.signal
    }, { modelRef: context.modelRef });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      request.signal.throwIfAborted();
      throw new LlmProviderHttpError(response.status, `决策接口 HTTP ${response.status}`);
    }
    const body = await readNativeBody(response, 4 * 1024 * 1024);
    request.signal.throwIfAborted();
    return new Response(new Uint8Array(body), { status: response.status, headers: Object.fromEntries(response.headers) });
  };
}

export function rethrowDecisionError(error: unknown, signal: AbortSignal): never {
  signal.throwIfAborted();
  let current = error;
  const visited = new Set<unknown>();
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    if (current instanceof LlmProviderHttpError) throw current;
    if ("status" in current && typeof current.status === "number" && current.status >= 400 && current.status <= 599) throw new LlmProviderHttpError(current.status, `决策接口 HTTP ${current.status}`);
    if ("statusCode" in current && typeof current.statusCode === "number" && current.statusCode >= 400 && current.statusCode <= 599) throw new LlmProviderHttpError(current.statusCode, `决策接口 HTTP ${current.statusCode}`);
    if (!current.cause) break;
    current = current.cause;
  }
  throw error;
}
