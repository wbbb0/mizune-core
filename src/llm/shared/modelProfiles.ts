import type { AppConfig } from "#config/config.ts";
import type { ModelProfile } from "#config/configModel.ts";

import type { ModelOperation } from "#config/modelOperations.ts";
export type SupportedModelType = ModelOperation;

export interface ResolvedModelRefsForType {
  acceptedModelRefs: string[];
  rejectedModelRefs: Array<{
    modelRef: string;
    reason: "unknown_model" | "unsupported_model_type";
    actualModelTypes?: SupportedModelType[];
  }>;
  primaryProfile: ModelProfile | undefined;
}

export function normalizeModelRefs(modelRef: string | string[]): string[] {
  const raw = Array.isArray(modelRef) ? modelRef : [modelRef];
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const value of raw) {
    const normalized = String(value ?? "").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    refs.push(normalized);
  }
  return refs;
}

export function getModelProfiles(config: AppConfig, modelRef: string | string[]): ModelProfile[] {
  return normalizeModelRefs(modelRef)
    .map((ref) => config.llm.models[ref])
    .filter((profile): profile is ModelProfile => profile != null);
}

export function getPrimaryModelProfile(config: AppConfig, modelRef: string | string[]): ModelProfile | undefined {
  return getModelProfiles(config, modelRef)[0];
}

export function resolveModelRefsForType(
  config: AppConfig,
  modelRef: string | string[],
  requiredModelType: SupportedModelType
): ResolvedModelRefsForType {
  const acceptedModelRefs: string[] = [];
  const rejectedModelRefs: ResolvedModelRefsForType["rejectedModelRefs"] = [];

  for (const ref of normalizeModelRefs(modelRef)) {
    const profile = config.llm.models[ref];
    if (!profile) {
      rejectedModelRefs.push({
        modelRef: ref,
        reason: "unknown_model"
      });
      continue;
    }
    if (!profile[requiredModelType]) {
      rejectedModelRefs.push({
        modelRef: ref,
        reason: "unsupported_model_type",
        actualModelTypes: (["chat", "embedding", "image", "transcription"] as const).filter((operation) => profile[operation] !== undefined)
      });
      continue;
    }
    acceptedModelRefs.push(ref);
  }

  return {
    acceptedModelRefs,
    rejectedModelRefs,
    primaryProfile: acceptedModelRefs[0] != null
      ? config.llm.models[acceptedModelRefs[0]]
      : undefined
  };
}
