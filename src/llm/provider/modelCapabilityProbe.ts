import pino from "pino";
import type { AppConfig } from "#config/config.ts";
import { llmCatalogFileSchema } from "#config/configModel.ts";
import { supportsStandardImageGeneration } from "#config/llmProviderDefinitions.ts";
import { modelOperations, type ModelOperation } from "#config/modelOperations.ts";
import { normalizeLlmCatalog } from "#llm/shared/modelTarget.ts";
import { generateConfiguredImage } from "#services/images/imageGeneration.ts";
import { getLlmProvider } from "./providerRegistry.ts";
import type { LlmProviderRequestContext, LlmUsage } from "./providerTypes.ts";
import { LlmProviderHttpError } from "./providerProtocolError.ts";

export interface ModelCapabilityProbeInput {
  provider: Record<string, unknown>;
  model: Record<string, unknown> & { upstreamModel: string };
  operation: ModelOperation;
  abortSignal?: AbortSignal;
}
export interface ModelCapabilityProbeResult {
  operation: ModelOperation;
  status: "passed" | "unsupported" | "inconclusive";
  durationMs: number;
  message: string;
  usage?: Pick<LlmUsage, "inputTokens" | "outputTokens" | "totalTokens">;
}
export class ModelCapabilityProbeBusyError extends Error {
  constructor() { super("已有模型测试正在进行，请稍后再试"); this.name = "ModelCapabilityProbeBusyError"; }
}

const silentLogger = pino({ level: "silent" });
const modelRef = "capability_probe/model";

/** The probe owns no conversation, assets or persistence; each run invokes at most one provider request. */
export class ModelCapabilityProbe {
  private running = false;
  constructor(private readonly config: AppConfig) {}

  async run(input: ModelCapabilityProbeInput): Promise<ModelCapabilityProbeResult> {
    if (this.running) throw new ModelCapabilityProbeBusyError();
    this.running = true;
    const started = performance.now();
    const result = (status: ModelCapabilityProbeResult["status"], message: string, usage?: LlmUsage): ModelCapabilityProbeResult => ({
      operation: input.operation, status, durationMs: Math.round(performance.now() - started), message,
      ...(usage ? { usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens } } : {})
    });
    try {
      input.abortSignal?.throwIfAborted();
      const context = createProbeContext(this.config, input);
      const provider = getLlmProvider(context);
      if (input.operation === "embedding" && !provider.embed) return result("unsupported", "当前供应商接入未实现向量接口，不能据此判断上游模型能力。");
      if (input.operation === "speech" && !provider.synthesize) return result("unsupported", "当前供应商接入未实现语音生成接口，不能据此判断上游模型能力。");
      if (input.operation === "decision" && !provider.decide) return result("unsupported", "当前供应商接入未实现原生决策接口，不能据此判断上游模型能力。");
      if (input.operation === "image" && !supportsStandardImageGeneration(context.providerConfig.type)) return result("unsupported", "当前供应商接入未实现图像生成接口，不能据此判断上游模型能力。");
      const timeoutMs = input.operation === "image" ? 90000 : 30000;
      const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(input.abortSignal ? [input.abortSignal] : [])]);
      const params = { abortSignal: signal, timeoutMsOverride: timeoutMs, skipDebugDump: true };
      // Hidden reasoning still consumes output tokens. A 32-token probe cannot test that route.
      const outputBudget = context.providerConfig.type === "google" ? Math.min(1024, Number(object(object(input.model[input.operation]).limits).maxOutputTokens) || 1024) : 32;
      let usage: LlmUsage | undefined;
      switch (input.operation) {
        case "chat": {
          const reply = await provider.generate(context, { ...params, messages: [{ role: "user", content: "请只回复：好" }], tools: [], maxOutputTokensOverride: outputBudget, enableThinkingOverride: false });
          if (!reply.text.trim() || reply.toolCalls.length) throw new Error("invalid_probe_output");
          usage = reply.usage;
          break;
        }
        case "embedding": {
          const reply = await provider.embed!(context, { ...params, texts: ["你好"], purpose: "document" });
          if (reply.vectors.length !== 1 || !reply.vectors[0]?.length || reply.vectors[0].some(value => !Number.isFinite(value))) throw new Error("invalid_probe_output");
          usage = reply.usage;
          break;
        }
        case "transcription": {
          const audio = { data: buildProbeWav().toString("base64"), format: "wav", mimeType: "audio/wav" };
          if (provider.transcribe) {
            const reply = await provider.transcribe(context, { ...params, audio });
            if (typeof reply.text !== "string") throw new Error("invalid_probe_output");
            usage = reply.usage;
          } else {
            const reply = await provider.generate(context, { ...params, messages: [
              { role: "system", content: "请转写音频；如果只有静音，请回复[静音]。不要补充内容。" },
              { role: "user", content: [{ type: "input_audio", input_audio: audio }] }
            ], tools: [], maxOutputTokensOverride: outputBudget, enableThinkingOverride: false });
            if (!reply.text.trim() || reply.toolCalls.length) throw new Error("invalid_probe_output");
            usage = reply.usage;
          }
          break;
        }
        case "speech": {
          const reply = await provider.synthesize!(context, { ...params, text: "你好", format: "mp3" });
          if (!reply.buffer.length || !reply.mimeType.startsWith("audio/")) throw new Error("invalid_probe_output");
          usage = reply.usage;
          break;
        }
        case "decision": {
          const reply = await provider.decide!(context, { ...params, input: "你好", questions: [{ name: "greeting", type: "predicate", instructions: "这是一句问候吗？" }] });
          const answer = reply.answers[0];
          if (reply.answers.length !== 1 || answer?.type !== "predicate" || !Number.isFinite(answer.probability)) throw new Error("invalid_probe_output");
          usage = reply.usage;
          break;
        }
        case "image": {
          await generateConfiguredImage(context.config, { prompt: "白色背景上的蓝色圆形，无文字。", abortSignal: signal, skipDebugDump: true });
          break;
        }
      }
      signal.throwIfAborted();
      return result("passed", input.operation === "transcription" ? "接口已返回有效转写响应；静音样本仅用于连通性验证，不代表识别准确率。" : "已完成一次简单请求并收到有效响应。", usage);
    } catch (error) {
      if (input.abortSignal?.aborted) return result("inconclusive", "测试已取消，未确认模型能力。");
      return result("inconclusive", safeProbeFailure(error));
    } finally {
      this.running = false;
    }
  }
}

function createProbeContext(base: AppConfig, input: ModelCapabilityProbeInput): LlmProviderRequestContext {
  if (!modelOperations.includes(input.operation)) throw new Error("invalid_probe_operation");
  const cleanModel: Record<string, unknown> = { upstreamModel: input.model.upstreamModel };
  const declared = object(input.model[input.operation]);
  if (input.operation === "chat" || input.operation === "transcription") {
    cleanModel[input.operation] = { capabilities: object(declared.capabilities), ...(input.provider.type === "google" && declared.googleThinking ? { googleThinking: declared.googleThinking } : {}), ...(input.operation === "transcription" ? { language: declared.language } : {}) };
  } else if (input.operation === "embedding") {
    cleanModel.embedding = { inputMode: declared.inputMode ?? "plain", ...(declared.queryPrefix ? { queryPrefix: declared.queryPrefix } : {}), ...(declared.documentPrefix ? { documentPrefix: declared.documentPrefix } : {}), ...(declared.dimensions ? { dimensions: declared.dimensions } : {}) };
  } else if (input.operation === "image") {
    const constraints = object(declared.constraints);
    const defaults: Record<string, unknown> = {};
    const sizes = stringArray(constraints.sizes).sort((left, right) => imagePixels(left) - imagePixels(right));
    if (sizes[0] && !["openrouter", "google"].includes(String(input.provider.type))) defaults.size = sizes[0];
    if (input.provider.type === "google") {
      const resolutions = stringArray(constraints.resolutions).sort((left, right) => Number.parseFloat(left) - Number.parseFloat(right));
      if (resolutions[0]) defaults.resolution = resolutions[0];
    }
    const qualities = input.provider.type === "google" ? [] : stringArray(constraints.qualities);
    if (qualities.includes("low")) defaults.quality = "low";
    else if (qualities[0]) defaults.quality = qualities[0];
    else if (input.provider.type === "openai") defaults.quality = "low";
    cleanModel.image = { constraints, defaults };
  } else if (input.operation === "speech") {
    cleanModel.speech = { voice: declared.voice ?? "alloy", format: "mp3", speed: 1 };
  } else cleanModel.decision = {};

  // Native-only operations are checked against the adapter even if catalog schemas omit them.
  const catalog = llmCatalogFileSchema.parseFromObject({ capability_probe: { ...input.provider, features: { thinking: object(input.provider.features).thinking }, models: { model: cleanModel } } });
  const normalized = normalizeLlmCatalog(catalog);
  const config = structuredClone(base);
  config.llm.providers = normalized.providers;
  config.llm.models = normalized.models;
  config.llm.debugDump.enabled = false;
  config.llm.imageGeneration.enabled = true;
  config.llm.imageGeneration.timeoutMs = 90000;
  config.llm.timeoutMs = 30000;
  config.llm.firstTokenTimeoutMs = 30000;
  config.llm.thinkingTimeoutMs = 30000;
  config.llm.enabled = true;
  config.chatFiles.enabled = true;
  config.chatFiles.maxUploadBytes = Math.min(config.chatFiles.maxUploadBytes, 10 * 1024 * 1024);
  config.context.embedding.timeoutMs = 30000;
  config.llm.routingPreset = "capability_probe";
  config.llm.routingPresets = { capability_probe: { imageGenerator: [modelRef] } };
  const providerConfig = normalized.providers.capability_probe!;
  const modelProfile = normalized.models[modelRef]!;
  const initial: LlmProviderRequestContext = { config, logger: silentLogger, modelRef, candidateIndex: 0,
    model: modelProfile.model, modelProfile, providerName: "capability_probe", providerConfig, baseUrl: "",
    ...(input.operation === "transcription" ? { operation: "transcription" as const } : {}) };
  initial.baseUrl = getLlmProvider(initial).resolveBaseUrl(providerConfig) ?? "";
  if (!initial.baseUrl) throw new Error("missing_probe_endpoint");
  return initial;
}

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []; }
function imagePixels(value: string): number { const dimensions = value.match(/^(\d+)x(\d+)$/); return dimensions ? Number(dimensions[1]) * Number(dimensions[2]) : Number.MAX_SAFE_INTEGER; }
function safeProbeFailure(error: unknown): string {
  const message = error instanceof Error ? `${error.name} ${error.message}` : "";
  const status = error instanceof LlmProviderHttpError ? error.statusCode : Number(message.match(/(?:HTTP|API error[: ]+)\s*(\d{3})/i)?.[1]);
  if (status === 401 || status === 403) return "上游拒绝访问，请检查密钥、账号权限和模型授权；未确认模型能力。";
  if (status === 429) return "上游限流或额度不足，请稍后重试；未确认模型能力。";
  if (/incomplete|max_output_tokens|invalid_probe_output/i.test(message)) return "低预算请求未产生完整有效结果；接口可能已响应，但尚未确认该用途。";
  if (/timeout|timed out|TimeoutError/i.test(message)) return "请求超时；模型可能需要更长的推理或加载时间，未确认能力。";
  if (/abort/i.test(message)) return "请求被中止；未确认模型能力。";
  if (status >= 400 && status < 600) return `上游返回 HTTP ${status}，可能与模型、参数或服务状态有关；未确认模型能力。`;
  return "未收到可验证的有效响应，请检查连接、模型名和接口参数；未确认模型能力。";
}

/** Half a second of 16 kHz mono PCM silence; generated in memory, never loaded from user audio. */
function buildProbeWav(): Buffer {
  const audioBytes = 16000;
  const wav = Buffer.alloc(44 + audioBytes);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + audioBytes, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(audioBytes, 40);
  return wav;
}
