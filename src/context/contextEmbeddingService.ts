import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { LlmClient } from "#llm/llmClient.ts";
import { getModelRefsForRole } from "#llm/shared/modelRouting.ts";
import type { ContextEmbeddingProfile } from "./contextTypes.ts";

export interface ContextEmbeddingBatch {
  profile: ContextEmbeddingProfile;
  vectors: number[][];
}

export class ContextEmbeddingService {
  constructor(
    private readonly config: AppConfig,
    private readonly llmClient: LlmClient,
    private readonly logger: Logger
  ) { }

  isConfigured(): boolean {
    return this.llmClient.isEmbeddingConfigured(getModelRefsForRole(this.config, "embedding"));
  }

  getStatus(): {
    configured: boolean;
    modelRefs: string[];
    timeoutMs: number;
    textPreprocessVersion: string;
    chunkerVersion: string;
  } {
    return {
      configured: this.isConfigured(),
      modelRefs: getModelRefsForRole(this.config, "embedding"),
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
    const result = await this.llmClient.embedTexts({
      texts,
      modelRefOverride: getModelRefsForRole(this.config, "embedding"),
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
