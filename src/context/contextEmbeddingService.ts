import { resolveProviderBaseUrl } from "#llm/provider/providerRegistry.ts";
import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { LlmClient } from "#llm/llmClient.ts";
import { getEmbeddingModelRefs } from "#llm/shared/embeddingTarget.ts";
import { createHash } from "node:crypto";
import { normalizeModelRefs, resolveModelRefsForType } from "#llm/shared/modelProfiles.ts";
import type { ContextEmbeddingProfile } from "./contextTypes.ts";

export interface ContextEmbeddingBatch {
  profile: ContextEmbeddingProfile;
  vectors: number[][];
}

export type ContextEmbeddingUnavailableReason =
  | "llm_disabled"
  | "model_not_configured"
  | "model_configuration_invalid"
  | "model_unavailable";

export type ContextEmbeddingAvailability = {
  available: true;
  modelRefs: string[];
} | {
  available: false;
  modelRefs: string[];
  reason: ContextEmbeddingUnavailableReason;
};

export class ContextEmbeddingService {
  private lastCheck: { signature: string; at: number; healthy: boolean; dimension?: number; error?: string } | null = null;

  private settingsSignature(): string {
    const refs = getEmbeddingModelRefs(this.config);
    return createHash("sha256").update(JSON.stringify(refs.map(ref => ({ ref, model: this.config.llm.models[ref], provider: this.config.llm.providers[this.config.llm.models[ref]?.provider ?? ""] })))).digest("hex");
  }

  async testConnection() {
    const batch = await this.embedTexts(["向量服务连接测试。"], { purpose: "document" });
    const query = await this.embedTexts(["连接测试"], { purpose: "query" });
    if (batch.profile.profileId !== query.profile.profileId) {
      const error = "查询与文档的向量空间不一致";
      this.lastCheck = { signature: this.settingsSignature(), at: Date.now(), healthy: false, error };
      throw new Error(error);
    }
    return { ok: true as const, dimension: batch.profile.dimension, profileId: batch.profile.profileId };
  }
  constructor(
    private readonly config: AppConfig,
    private readonly llmClient: LlmClient,
    private readonly logger: Logger
  ) { }

  getAvailability(): ContextEmbeddingAvailability {
    const modelRefs = normalizeModelRefs(getEmbeddingModelRefs(this.config));
    if (!this.config.llm.enabled) {
      return { available: false, modelRefs, reason: "llm_disabled" };
    }
    if (modelRefs.length === 0) {
      return { available: false, modelRefs, reason: "model_not_configured" };
    }
    if (resolveModelRefsForType(this.config, modelRefs, "embedding").acceptedModelRefs.length === 0) {
      return { available: false, modelRefs, reason: "model_configuration_invalid" };
    }
    if (!this.llmClient.isEmbeddingConfigured(modelRefs)) {
      return { available: false, modelRefs, reason: "model_unavailable" };
    }
    return { available: true, modelRefs };
  }

  isAvailable(): boolean {
    return this.getAvailability().available;
  }

  getStatus(): {
    health: "untested" | "healthy" | "failed";
    lastCheckedAt?: number;
    lastError?: string;
    dimension?: number;
    available: boolean;
    modelRefs: string[];
    unavailableReason?: ContextEmbeddingUnavailableReason;
    timeoutMs: number;
    textPreprocessVersion: string;
    chunkerVersion: string;
  } {
    const availability = this.getAvailability();
    const check = this.lastCheck?.signature === this.settingsSignature() ? this.lastCheck : null;
    return {
      health: check ? check.healthy ? "healthy" : "failed" : "untested",
      ...(check ? { lastCheckedAt: check.at, lastError: check.error, dimension: check.dimension } : {}),
      available: availability.available,
      modelRefs: availability.modelRefs,
      ...(!availability.available ? { unavailableReason: availability.reason } : {}),
      timeoutMs: this.config.context.embedding.timeoutMs,
      textPreprocessVersion: this.config.context.embedding.textPreprocessVersion,
      chunkerVersion: this.config.context.embedding.chunkerVersion
    };
  }

  async embedTexts(texts: string[], options?: {
    abortSignal?: AbortSignal;
    purpose?: "query" | "document";
  }): Promise<ContextEmbeddingBatch> {
    if (texts.length === 0) {
      throw new Error("embedTexts requires at least one text");
    }
    const availability = this.getAvailability();
    if (!availability.available) {
      throw new Error(`Embedding 功能不可用: ${availability.reason}`);
    }
    const settings = this.config.llm.models[availability.modelRefs[0]!]!.embedding;
    const provider = this.config.llm.providers[this.config.llm.models[availability.modelRefs[0]!]!.provider]!;
    const inputProfile = createHash("sha256").update(JSON.stringify({
      inputMode: settings?.inputMode,
      ...(settings?.inputMode === "qwen3" ? { queryInstruction: settings.queryInstruction } : {}),
      type: provider.type,
      baseUrl: resolveProviderBaseUrl(provider)?.replace(/\/+$/, "")
    })).digest("hex").slice(0, 16);
    const signature = this.settingsSignature();
    try {
      const result = await this.llmClient.embedTexts({
        purpose: options?.purpose ?? "document",
        texts,
        modelRefOverride: availability.modelRefs,
        timeoutMsOverride: this.config.context.embedding.timeoutMs,
        ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {})
      });
      const dimension = result.vectors[0]?.length ?? 0;
      if (!Number.isInteger(dimension) || dimension <= 0) {
        throw new Error("Embedding provider returned an empty vector");
      }
      if (result.vectors.length !== texts.length || result.vectors.some(vector => vector.length !== dimension || vector.some(value => !Number.isFinite(value)))) {
        throw new Error("向量返回数量、维度或数值不合法");
      }
      if (signature !== this.settingsSignature()) throw new Error("向量配置在请求期间发生变化，请重试");
      this.lastCheck = { signature, at: Date.now(), healthy: true, dimension };
      const profile: ContextEmbeddingProfile = {
        profileId: buildEmbeddingProfileId({
          instanceName: this.config.configRuntime.instanceName,
          modelRef: result.modelRef,
          providerName: result.providerName,
          model: result.model,
          dimension,
          textPreprocessVersion: `${this.config.context.embedding.textPreprocessVersion}:${inputProfile}`,
          chunkerVersion: this.config.context.embedding.chunkerVersion
        }),
        instanceName: this.config.configRuntime.instanceName,
        provider: result.providerName,
        model: result.model,
        dimension,
        distance: "cosine",
        textPreprocessVersion: this.config.context.embedding.textPreprocessVersion,
        chunkerVersion: this.config.context.embedding.chunkerVersion
      };
      this.logger.debug({
        profileId: profile.profileId,
        textCount: texts.length,
        dimension
      }, "context_embeddings_created");
      return {
        profile,
        vectors: result.vectors
      };
    } catch (error) {
      this.lastCheck = { signature, at: Date.now(), healthy: false, error: error instanceof Error ? error.message : String(error) };
      throw error;
    }
  }
}

function buildEmbeddingProfileId(input: {
  instanceName: string;
  modelRef: string;
  providerName: string;
  model: string;
  dimension: number;
  textPreprocessVersion: string;
  chunkerVersion: string;
}): string {
  return [
    "embedding",
    input.instanceName,
    input.providerName,
    input.modelRef,
    input.model,
    String(input.dimension),
    input.textPreprocessVersion,
    input.chunkerVersion
  ].map((part) => encodeURIComponent(part)).join(":");
}
