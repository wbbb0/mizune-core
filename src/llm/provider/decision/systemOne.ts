import { encodeSystemOne, decodeSystemOne } from "./systemOneCodec.ts";
import { OpenRouter } from "@openrouter/sdk";
import { HTTPClient } from "@openrouter/sdk/lib/http.js";
import { isObject, nativeUsage } from "../nativeCapabilityHttp.ts";
import type { LlmProviderRequestContext } from "../providerTypes.ts";
import type { LlmDecideParams, LlmDecideResult } from "../nativeCapabilityTypes.ts";
import { decisionFetch, decisionSignal, rethrowDecisionError } from "./transport.ts";
import { validateDecisionRequest } from "./validation.ts";

export function systemOneEndpoint(baseUrl: string, provider: "openrouter" | "dashscope"): URL {
  const url = new URL(baseUrl);
  url.search = ""; url.hash = "";
  const path = url.pathname.replace(/\/+$/, "");
  const prefix = path.replace(/\/(?:compatible-mode\/v1|api\/v1)$/, "");
  url.pathname = `${prefix}${provider === "openrouter" ? "/api/alpha/decisions" : "/compatible-mode/v1/systemone"}`;
  return url;
}

export async function requestSystemOne(context: LlmProviderRequestContext, params: LlmDecideParams): Promise<LlmDecideResult> {
  validateDecisionRequest(context, params);
  const provider = context.providerConfig.type;
  if (provider !== "openrouter" && provider !== "dashscope") throw new Error("供应商未实现 System One");
  if (provider === "dashscope" && params.questions.length > 16) throw new Error("百炼决策最多支持 16 个问题");
  const body = { model: context.model, ...encodeSystemOne(params) };
  const signal = decisionSignal(context, params);
  try {
    const fetcher = decisionFetch(context);
    const endpoint = systemOneEndpoint(context.baseUrl, provider);
    if (provider === "openrouter") {
      // Alpha operations ignore the constructor's serverURL. Override per operation.
      const client = new OpenRouter({ apiKey: context.providerConfig.apiKey ?? "", httpClient: new HTTPClient({ fetcher }), retryConfig: { strategy: "none" } });
      const serverURL = new URL(endpoint); serverURL.pathname = serverURL.pathname.replace(/\/api\/alpha\/decisions$/, "");
      const result = await client.alpha.decisions.create({ decisionsRequest: body }, { serverURL: serverURL.toString().replace(/\/$/, ""), signal });
      signal.throwIfAborted();
      return { answers: decodeSystemOne(result.answers, params), usage: nativeUsage(context, { input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens, total_tokens: result.usage.inputTokens + result.usage.outputTokens, input_tokens_details: { cached_tokens: result.usage.inputTokensDetails?.cachedTokens } }) };
    }
    const response = await fetcher(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${context.providerConfig.apiKey ?? ""}` }, body: JSON.stringify(body), signal });
    const result: unknown = await response.json();
    signal.throwIfAborted();
    if (!isObject(result)) throw new Error("System One 响应无效");
    return { answers: decodeSystemOne(result.answers, params), usage: nativeUsage(context, result.usage) };
  } catch (error) {
    rethrowDecisionError(error, signal);
  }
}
