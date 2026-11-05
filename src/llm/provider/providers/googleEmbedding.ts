import { estimateTokens } from "#conversation/session/tokenEstimator.ts";
import { createProviderTimeoutController, rethrowProviderAbortReason } from "../providerTimeout.ts";
import { createEmptyUsage, type LlmEmbeddingParams, type LlmEmbeddingResult, type LlmProviderRequestContext } from "../providerTypes.ts";
import { runAiStudioOperation } from "./googleSdkOperation.ts";

export async function requestGoogleEmbeddings(context: LlmProviderRequestContext, params: LlmEmbeddingParams): Promise<LlmEmbeddingResult> {
  const settings = context.modelProfile.embedding;
  if (!settings) throw new Error("模型未配置向量用途");
  if (!params.texts.length || params.texts.some(text => typeof text !== "string" || !text.trim())) throw new Error("向量输入必须是非空文本列表");
  if (!["plain", "task_type", "task_prefix"].includes(settings.inputMode)) throw new Error("Google 向量输入模式只支持 plain、task_type 或 task_prefix");
  const purpose = params.purpose ?? "document";
  const prefix = purpose === "query" ? settings.queryPrefix : settings.documentPrefix;
  if (settings.inputMode === "task_prefix" && !prefix) throw new Error("task_prefix 模式必须配置查询和文档前缀");
  const texts = settings.inputMode === "task_prefix" ? params.texts.map(text => `${prefix}${text}`) : params.texts;
  if (settings.limits.maxInputTokens && texts.some(text => estimateTokens(text, context.config.conversation.historyCompression.tokenEstimation) > settings.limits.maxInputTokens!)) {
    throw new Error("向量输入的估算 token 数超过模型输入上限，请调整分块长度");
  }
  params.abortSignal?.throwIfAborted();
  const timeoutMs = params.timeoutMsOverride ?? context.config.context.embedding.timeoutMs;
  const timeout = createProviderTimeoutController({ totalTimeoutMs: timeoutMs, firstTokenTimeoutMs: timeoutMs });
  timeout.markFirstResponseReceived();
  const signal = AbortSignal.any([timeout.controller.signal, ...(params.abortSignal ? [params.abortSignal] : [])]);
  try {
    return await runAiStudioOperation({ ...context, signal, maxResponseBytes: 32 * 1024 * 1024 }, async (client, signal) => {
      const response = await client.models.embedContent({
        model: context.model,
        // Independent Content objects prevent multimodal-capable models aggregating several texts.
        contents: texts.map(text => ({ role: "user", parts: [{ text }] })),
        config: {
          abortSignal: signal,
          ...(settings.dimensions ? { outputDimensionality: settings.dimensions } : {}),
          ...(settings.inputMode === "task_type" ? { taskType: purpose === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT" } : {})
        }
      });
      const rows = response.embeddings;
      if (!rows || rows.length !== texts.length) throw new Error(`Google 向量数量不匹配：需要 ${texts.length} 条，返回 ${rows?.length ?? 0} 条`);
      let dimension = settings.dimensions;
      const vectors = rows.map(row => {
        const values = row.values;
        if (!Array.isArray(values) || !values.length || values.some(value => typeof value !== "number" || !Number.isFinite(value))) throw new Error("Google 返回无效的向量数值");
        dimension ??= values.length;
        if (values.length !== dimension) throw new Error("Google 返回的向量维度不一致或未满足配置");
        let maximum = 0;
        for (const value of values) maximum = Math.max(maximum, Math.abs(value));
        if (!maximum) throw new Error("Google 返回零向量");
        const norm = Math.sqrt(values.reduce((sum, value) => sum + (value / maximum) ** 2, 0));
        return values.map(value => (value / maximum) / norm);
      });
      return { vectors, usage: { ...createEmptyUsage(context.modelRef, context.model), requestCount: 1 } };
    });
  } catch (error) {
    rethrowProviderAbortReason(signal, error);
  } finally { timeout.cleanup(); }
}
