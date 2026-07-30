import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { LlmClient } from "#llm/llmClient.ts";
import { getModelRefsForRole } from "#llm/shared/modelRouting.ts";
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
  constructor(
    private readonly config: AppConfig,
    private readonly llmClient: LlmClient,
    private readonly logger: Logger
  ) { }

  getAvailability(): ContextEmbeddingAvailability {
    const modelRefs = normalizeModelRefs(getModelRefsForRole(this.config, "embedding"));
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
    available: boolean;
    modelRefs: string[];
    unavailableReason?: ContextEmbeddingUnavailableReason;
    timeoutMs: number;
    textPreprocessVersion: string;
    chunkerVersion: string;
  } {
    const availability = this.getAvailability();
    return {
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
  }): Promise<ContextEmbeddingBatch> {
    if (texts.length === 0) {
      throw new Error("embedTexts requires at least one text");
    }
    const availability = this.getAvailability();
    if (!availability.available) {
      throw new Error(`Embedding 功能不可用: ${availability.reason}`);
    }
    const result = await this.llmClient.embedTexts({
      texts,
      modelRefOverride: availability.modelRefs,
      timeoutMsOverride: this.config.context.embedding.timeoutMs,
      ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {})
    });
    const dimension = result.vectors[0]?.length ?? 0;
    if (!Number.isInteger(dimension) || dimension <= 0) {
      throw new Error("Embedding provider returned an empty vector");
    }
    const profile: ContextEmbeddingProfile = {
      profileId: buildEmbeddingProfileId({
        instanceName: this.config.configRuntime.instanceName,
        modelRef: result.modelRef,
        providerName: result.providerName,
        model: result.model,
        dimension,
        textPreprocessVersion: this.config.context.embedding.textPreprocessVersion,
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
