import type { LlmGenerateParams, LlmGenerateResult, LlmProvider, LlmProviderRequestContext } from "./providerTypes.ts";
import { getLlmProvider } from "./providerRegistry.ts";
import { withProviderExchangeDump } from "./providerExchangeDump.ts";
import type { NativeCapabilityParams, LlmTranscribeParams, LlmTranscribeResult } from "./nativeCapabilityTypes.ts";

/** Select before a charged request; synthesis never retries once a provider has been invoked. */
export async function runModelCapability<T>(
  contexts: LlmProviderRequestContext[],
  params: NativeCapabilityParams,
  invoke: (provider: LlmProvider, context: LlmProviderRequestContext) => Promise<T> | undefined,
  policy: { kind: "audio" | "decision" | "transcription"; allowFallback: boolean; shouldFallback?: (error: unknown) => boolean }
): Promise<T> {
  params.abortSignal?.throwIfAborted();
  let lastError: unknown;
  for (let index = 0; index < contexts.length; index++) {
    const context = contexts[index]!;
    try {
      // Callback invocation stays inside the exchange scope so request dumps remain complete.
      const result = await withProviderExchangeDump(context, params.skipDebugDump, async () => invoke(getLlmProvider(context), context), policy.kind);
      if (result !== undefined) return result;
    } catch (error) {
      params.abortSignal?.throwIfAborted();
      lastError = error;
      if (!policy.allowFallback || !policy.shouldFallback?.(error)) throw error;
      context.logger.warn({ modelRef: context.modelRef }, "native_capability_candidate_failed");
    }
  }
  throw lastError ?? new Error("未配置支持此能力的模型");
}

/** Compatibility providers transcribe through their documented chat audio input protocol. */
export async function transcribeWithChat(
  context: LlmProviderRequestContext,
  params: LlmTranscribeParams,
  generate: (params: LlmGenerateParams) => Promise<LlmGenerateResult>
): Promise<LlmTranscribeResult> {
  const result = await generate({
    operation: "transcription",
    modelRefOverride: context.modelRef,
    ...(params.timeoutMsOverride ? { timeoutMsOverride: params.timeoutMsOverride } : {}),
    ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    ...(params.skipDebugDump !== undefined ? { skipDebugDump: params.skipDebugDump } : {}),
    enableThinkingOverride: context.config.llm.audioTranscription.enableThinking,
    messages: [
      { role: "system", content: params.prompt ?? context.modelProfile.transcription?.prompt ?? "你是聊天音频听写器。请准确转写音频中的实际内容，不总结、不润色、不补充猜测。听不清或只有环境音时输出[无法识别]。输出单段纯文本，不加引号、编号或解释。" },
      { role: "user", content: [
        { type: "text", text: "请转写这段聊天音频。" },
        { type: "input_audio", input_audio: params.audio }
      ] }
    ]
  });
  return { text: result.text, usage: result.usage };
}
