import type {
  LlmCatalogConfig,
  LlmCatalogFile,
  LlmRoutingPreset,
  LlmRoutingPresetCatalogFile,
  LlmRoutingPresetFile,
  ModelTargetRef
} from "#config/configModel.ts";

const MODEL_TARGET_SEPARATOR = "/";

const ROUTING_MODEL_FIELDS = [
  "mainSmall",
  "mainLarge",
  "summarizer",
  "textInspector",
  "sessionCaptioner",
  "imageCaptioner",
  "imageInspector",
  "audioTranscription",
  "turnPlanner",
  "embedding"
] as const satisfies ReadonlyArray<Exclude<keyof LlmRoutingPresetFile, "historyWindow" | "tokenLimits">>;

function assertModelTargetAlias(value: string, label: "provider" | "model"): void {
  if (!value || value.includes(MODEL_TARGET_SEPARATOR)) {
    throw new Error(`Invalid ${label} alias ${JSON.stringify(value)}: aliases must be non-empty and cannot contain '/'`);
  }
}

/**
 * 生成只在运行时使用的模型索引。斜杠不是持久化协议的一部分；配置别名禁止包含斜杠，
 * 因而 canonical key 可以无歧义地还原为联合引用。
 */
export function toCanonicalModelRef(target: ModelTargetRef): string {
  assertModelTargetAlias(target.provider, "provider");
  assertModelTargetAlias(target.model, "model");
  return `${target.provider}${MODEL_TARGET_SEPARATOR}${target.model}`;
}

export function fromCanonicalModelRef(modelRef: string): ModelTargetRef | null {
  const separatorIndex = modelRef.indexOf(MODEL_TARGET_SEPARATOR);
  if (separatorIndex <= 0 || separatorIndex !== modelRef.lastIndexOf(MODEL_TARGET_SEPARATOR)) {
    return null;
  }

  const provider = modelRef.slice(0, separatorIndex);
  const model = modelRef.slice(separatorIndex + MODEL_TARGET_SEPARATOR.length);
  if (!model) {
    return null;
  }
  return { provider, model };
}

export function normalizeLlmCatalog(catalog: LlmCatalogFile): Pick<LlmCatalogConfig, "providers" | "models"> {
  const providers: LlmCatalogConfig["providers"] = {};
  const models: LlmCatalogConfig["models"] = {};

  for (const [providerAlias, catalogProvider] of Object.entries(catalog)) {
    const { models: providerModels, ...providerConfig } = catalogProvider;
    providers[providerAlias] = providerConfig;

    for (const [modelAlias, catalogProfile] of Object.entries(providerModels)) {
      const { upstreamModel, ...profile } = catalogProfile;
      const canonicalRef = toCanonicalModelRef({
        provider: providerAlias,
        model: modelAlias
      });
      models[canonicalRef] = {
        ...profile,
        provider: providerAlias,
        model: upstreamModel
      };
    }
  }

  return { providers, models };
}

export function normalizeRoutingPresetTargetCatalog(
  catalog: LlmRoutingPresetCatalogFile
): Record<string, LlmRoutingPreset> {
  const normalizedCatalog: Record<string, LlmRoutingPreset> = {};

  for (const [presetName, preset] of Object.entries(catalog)) {
    const normalizedPreset: Record<string, unknown> = {
      ...(preset.historyWindow == null ? {} : { historyWindow: preset.historyWindow }),
      ...(preset.tokenLimits == null ? {} : { tokenLimits: preset.tokenLimits })
    };

    for (const field of ROUTING_MODEL_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(preset, field)) {
        continue;
      }
      normalizedPreset[field] = (preset[field] ?? []).map(toCanonicalModelRef);
    }

    normalizedCatalog[presetName] = normalizedPreset as LlmRoutingPreset;
  }

  return normalizedCatalog;
}
