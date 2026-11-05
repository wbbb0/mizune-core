import { requestGoogleEmbeddings } from "./googleEmbedding.ts";
import { randomUUID } from "node:crypto";
import type { Part } from "@google/genai";
import { numberOrNull, type LlmProvider, type LlmProviderGenerateParams, type LlmProviderRequestContext, type LlmToolCall } from "../providerTypes.ts";
import { createProviderStreamAccumulator, createReportedUsage } from "../providerStreamAdapter.ts";
import { createProviderTimeoutController, rethrowProviderAbortReason } from "../providerTimeout.ts";
import { LlmProviderPolicyError } from "../providerProtocolError.ts";
import { readNativeSearchCitations } from "../../shared/nativeSearchCitations.ts";
import { createAiStudioClient, normalizeGoogleSdkError } from "./googleSdkClient.ts";
import { buildGoogleContents, googleReplayScope } from "./googleContent.ts";
import { buildAiStudioConfig } from "./googleRequest.ts";

export class GoogleAiStudioProvider implements LlmProvider {
  readonly type = "google" as const;
  readonly supportsStructuredOutput = true;
  readonly embed = requestGoogleEmbeddings;

  resolveBaseUrl(config: LlmProviderRequestContext["providerConfig"]) {
    return config.baseUrl?.trim() || "https://generativelanguage.googleapis.com/v1beta";
  }

  async generate(context: LlmProviderRequestContext, params: LlmProviderGenerateParams) {
    const timeout = createProviderTimeoutController({
      totalTimeoutMs: params.timeoutMsOverride ?? context.config.llm.timeoutMs,
      firstTokenTimeoutMs: context.config.llm.firstTokenTimeoutMs,
      thinkingTimeoutMs: context.config.llm.thinkingTimeoutMs
    });
    const signal = timeout.controller.signal;
    const forwardAbort = () => timeout.controller.abort(params.abortSignal?.reason);
    params.abortSignal?.addEventListener("abort", forwardAbort, { once: true });
    if (params.abortSignal?.aborted) forwardAbort();
    let completed = false;
    const responses: Response[] = [];
    try {
      signal.throwIfAborted();
      const client = createAiStudioClient({ config: context.config, apiKey: context.providerConfig.apiKey, baseUrl: context.baseUrl, modelRef: context.modelRef, providerProxy: context.providerConfig.proxy, onResponse: response => responses.push(response) });
      const contents = buildGoogleContents(context, params.messages);
      const config = buildAiStudioConfig(context, params, signal);
      const accumulator = createProviderStreamAccumulator({ modelRef: context.modelRef, model: context.model });
      const parts: Part[] = [];
      const toolCalls: LlmToolCall[] = [];
      const citations: Array<{ url: string; title?: string }> = [];
      let finishReason: string | undefined;
      let sawCandidate = false;
      const stream = await client.models.generateContentStream({ model: context.model, contents, config });
      for await (const chunk of stream) {
        signal.throwIfAborted();
        if (chunk.promptFeedback?.blockReason) throw new LlmProviderPolicyError("content_filter", `Google prompt blocked: ${chunk.promptFeedback.blockReason}`);
        const usage = chunk.usageMetadata;
        if (usage) accumulator.replaceUsage(createReportedUsage({
          modelRef: context.modelRef, model: context.model,
          inputTokens: numberOrNull(usage.promptTokenCount), outputTokens: numberOrNull(usage.candidatesTokenCount), totalTokens: numberOrNull(usage.totalTokenCount),
          cachedTokens: numberOrNull(usage.cachedContentTokenCount) ?? 0, reasoningTokens: numberOrNull(usage.thoughtsTokenCount) ?? 0, providerReported: true
        }));
        if ((chunk.candidates?.length ?? 0) > 1) throw new Error("Google 返回多个候选，当前请求只允许单个候选");
        const candidate = chunk.candidates?.[0];
        if (!candidate) continue;
        sawCandidate = true;
        if (candidate.finishReason) {
          if (finishReason && finishReason !== candidate.finishReason) throw new Error("Google 流终态冲突");
          finishReason = candidate.finishReason;
        }
        for (const grounding of candidate.groundingMetadata?.groundingChunks ?? []) {
          if (grounding.web?.uri) citations.push({ url: grounding.web.uri, ...(grounding.web.title ? { title: grounding.web.title } : {}) });
        }
        for (const part of candidate.content?.parts ?? []) {
          if ((part.text?.length ?? 0) > 0 || part.thoughtSignature || part.functionCall || part.toolCall || part.toolResponse || part.executableCode || part.codeExecutionResult || part.inlineData || part.fileData) timeout.markFirstResponseReceived();
          // Text chat cannot persist generated media as signed replay state.
          if (part.inlineData || part.fileData) throw new Error("Google 文本接入暂不支持媒体输出，请使用专用媒体接口");
          parts.push(structuredClone(part));
          if (typeof part.text === "string" && part.text) {
            if (part.thought) {
              timeout.markReasoningStarted();
              if (params.enableThinkingOverride) accumulator.appendReasoningDelta(part.text, params.onReasoningDelta);
            } else {
              timeout.markFirstTextReceived();
              await accumulator.appendTextDelta(part.text, params.onTextDelta);
            }
          }
          if (part.functionCall) {
            const call = part.functionCall;
            if (!call.name || call.willContinue || call.partialArgs || (call.args !== undefined && (!call.args || Array.isArray(call.args) || typeof call.args !== "object"))) throw new Error("Google 返回未完成或无效的工具调用参数");
            const id = call.id || `google_${randomUUID()}`;
            timeout.markFirstTextReceived();
            toolCalls.push({ id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) }, ...(part.thoughtSignature ? { providerMetadata: { google: { thoughtSignature: part.thoughtSignature } } } : {}) });
          }
        }
      }
      signal.throwIfAborted();
      if (["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"].includes(finishReason ?? "")) throw new LlmProviderPolicyError("content_filter", `Google response blocked: ${finishReason}`);
      if (finishReason !== "STOP") throw new Error(`Google 流未正常完成: ${finishReason ?? "missing finishReason"}`);
      if (!sawCandidate || (!accumulator.text.trim() && !toolCalls.length)) throw new Error("LLM returned empty content");
      completed = true;
      return {
        text: accumulator.text.trim(), reasoningContent: accumulator.reasoningContent, toolCalls, usage: accumulator.usage,
        assistantMetadata: { googleParts: parts, googleReplayScope: googleReplayScope(context), citations: readNativeSearchCitations({ citations }) }
      };
    } catch (error) {
      if (signal.aborted) rethrowProviderAbortReason(signal, error);
      throw normalizeGoogleSdkError(error);
    } finally {
      // SDK iterator.return only releases its reader. Abort our request on every abnormal exit.
      if (!completed && !signal.aborted) timeout.controller.abort(new Error("Google stream closed before completion"));
      if (!completed) await Promise.allSettled(responses.map(response => response.body?.cancel(signal.reason)));
      timeout.cleanup();
      params.abortSignal?.removeEventListener("abort", forwardAbort);
    }
  }
}
