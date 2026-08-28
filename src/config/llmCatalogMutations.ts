import type {
  LlmCatalogFile,
  LlmRoutingPresetCatalogFile,
  LlmRoutingPresetFile,
  ModelTargetRef
} from "./configModel.ts";

export type LlmCatalogProviderMutation =
  | { kind: "rename_provider"; provider: string; nextProvider: string }
  | { kind: "delete_provider"; provider: string };

export interface LlmProviderReferenceImpact {
  preset: string;
  role: RoutingModelField;
  indexes: number[];
}

export interface LlmProviderMutationImpact {
  provider: string;
  exists: boolean;
  modelCount: number;
  referenceCount: number;
  references: LlmProviderReferenceImpact[];
  emptiedRoles: Array<{ preset: string; role: RoutingModelField }>;
}

export const ROUTING_MODEL_FIELDS = [
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

export type RoutingModelField = typeof ROUTING_MODEL_FIELDS[number];

export function summarizeLlmProviderMutationImpact(
  catalog: LlmCatalogFile,
  routingPresets: LlmRoutingPresetCatalogFile,
  provider: string
): LlmProviderMutationImpact {
  const references: LlmProviderReferenceImpact[] = [];
  const emptiedRoles: LlmProviderMutationImpact["emptiedRoles"] = [];
  let referenceCount = 0;

  for (const [presetName, preset] of Object.entries(routingPresets)) {
    for (const role of ROUTING_MODEL_FIELDS) {
      const targets = preset[role];
      if (targets == null) {
        continue;
      }
      const indexes: number[] = [];
      targets.forEach((target, index) => {
        if (target.provider === provider) {
          indexes.push(index);
        }
      });
      if (indexes.length === 0) {
        continue;
      }
      referenceCount += indexes.length;
      references.push({ preset: presetName, role, indexes });
      if (indexes.length === targets.length) {
        emptiedRoles.push({ preset: presetName, role });
      }
    }
  }

  return {
    provider,
    exists: provider in catalog,
    modelCount: Object.keys(catalog[provider]?.models ?? {}).length,
    referenceCount,
    references,
    emptiedRoles
  };
}

export function applyLlmCatalogProviderMutations(
  routingPresets: LlmRoutingPresetCatalogFile,
  mutations: readonly LlmCatalogProviderMutation[]
): LlmRoutingPresetCatalogFile {
  const next = structuredClone(routingPresets);

  for (const mutation of mutations) {
    for (const preset of Object.values(next)) {
      for (const role of ROUTING_MODEL_FIELDS) {
        const targets = preset[role];
        if (targets == null) {
          continue;
        }
        if (mutation.kind === "rename_provider") {
          preset[role] = targets.map((target): ModelTargetRef => target.provider === mutation.provider
            ? { provider: mutation.nextProvider, model: target.model }
            : target);
          continue;
        }
        preset[role] = targets.filter((target) => target.provider !== mutation.provider);
      }
    }
  }

  return next;
}

export function validateLlmCatalogProviderMutations(
  previousCatalog: LlmCatalogFile,
  nextCatalog: LlmCatalogFile,
  mutations: readonly LlmCatalogProviderMutation[]
): void {
  const remainingProviders = new Set(Object.keys(previousCatalog));
  const retiredProviderNames = new Set<string>();

  for (const mutation of mutations) {
    if (!remainingProviders.has(mutation.provider)) {
      throw new Error(`Provider mutation references missing provider: ${mutation.provider}`);
    }
    if (mutation.kind === "rename_provider") {
      if (remainingProviders.has(mutation.nextProvider)) {
        throw new Error(`Provider rename target already exists: ${mutation.nextProvider}`);
      }
      retiredProviderNames.add(mutation.provider);
      remainingProviders.delete(mutation.provider);
      remainingProviders.add(mutation.nextProvider);
      continue;
    }
    retiredProviderNames.add(mutation.provider);
    remainingProviders.delete(mutation.provider);
  }

  for (const provider of remainingProviders) {
    if (!(provider in nextCatalog)) {
      throw new Error(`Provider ${provider} was removed without an explicit mutation`);
    }
  }
  for (const provider of retiredProviderNames) {
    if (!remainingProviders.has(provider) && provider in nextCatalog) {
      throw new Error(`Provider mutation did not remove its source key: ${provider}`);
    }
  }
}
