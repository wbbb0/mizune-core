import OpenAI from "openai";
import type { LlmProviderRequestContext } from "./providerTypes.ts";
import type { LlmDecideParams, LlmDecideResult } from "./nativeCapabilityTypes.ts";
import { nativeUsage } from "./nativeCapabilityHttp.ts";
import { decisionFetch, decisionSignal, rethrowDecisionError } from "./decision/transport.ts";
import { validateDecisionRequest, validateDecisionAnswer } from "./decision/validation.ts";

export async function requestOpenAiDecision(context: LlmProviderRequestContext, params: LlmDecideParams): Promise<LlmDecideResult> {
  validateDecisionRequest(context, params);
  const signal = decisionSignal(context, params);
  try {
    const client = new OpenAI({ apiKey: context.providerConfig.apiKey || "unused", baseURL: context.baseUrl, maxRetries: 0, fetch: decisionFetch(context) });
    const payload = await client.decisions.create({ model: context.model, input: params.input, questions: params.questions }, { signal });
    signal.throwIfAborted();
    if (payload.answers.length !== params.questions.length) throw new Error("决策响应的答案数量不匹配");
    return { answers: payload.answers.map((answer, index) => validateDecisionAnswer(answer, params.questions[index]!)), usage: nativeUsage(context, payload.usage) };
  } catch (error) {
    rethrowDecisionError(error, signal);
  }
}
