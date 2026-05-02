import type { AppConfig } from "#config/config.ts";
import type { LlmRoutingPreset, ModelProfile } from "#config/configModel.ts";
import {
  resolveModelRefsForType,
  type ResolvedModelRefsForType,
  type SupportedModelType
} from "./modelProfiles.ts";

export type LlmRoutingRole =
  | "main_small"
  | "main_large"
  | "summarizer"
  | "session_captioner"
  | "image_captioner"
  | "image_inspector"
  | "audio_transcription"
  | "turn_planner"
  | "embedding";

interface RoutingRoleDefinition {
  label: string;
  requiredModelType: SupportedModelType;
  getModelRefs: (preset: LlmRoutingPreset) => string[] | undefined;
}

export interface RoutingPresetValidationResult {
  presetName: string;
  preset: LlmRoutingPreset | null;
  warnings: string[];
}

type RoutingPresetField = keyof LlmRoutingPreset;

const routingRoleDefinitions: Record<LlmRoutingRole, RoutingRoleDefinition & {
  presetField: RoutingPresetField;
}> = {
  main_small: {
    label: "主路由轻量模型",
    requiredModelType: "chat",
    presetField: "mainSmall",
    getModelRefs: (preset) => preset.mainSmall
  },
  main_large: {
    label: "主路由完整模型",
    requiredModelType: "chat",
    presetField: "mainLarge",
    getModelRefs: (preset) => preset.mainLarge
  },
  summarizer: {
    label: "总结器",
    requiredModelType: "chat",
    presetField: "summarizer",
    getModelRefs: (preset) => preset.summarizer
  },
  session_captioner: {
    label: "会话标题生成",
    requiredModelType: "chat",
    presetField: "sessionCaptioner",
    getModelRefs: (preset) => preset.sessionCaptioner
  },
  image_captioner: {
    label: "图片描述",
    requiredModelType: "chat",
    presetField: "imageCaptioner",
    getModelRefs: (preset) => preset.imageCaptioner
  },
  image_inspector: {
    label: "图片精读",
    requiredModelType: "chat",
    presetField: "imageInspector",
    getModelRefs: (preset) => preset.imageInspector
  },
  audio_transcription: {
    label: "音频转写",
    requiredModelType: "transcription",
    presetField: "audioTranscription",
    getModelRefs: (preset) => preset.audioTranscription
  },
  turn_planner: {
    label: "轮次规划",
    requiredModelType: "chat",
    presetField: "turnPlanner",
    getModelRefs: (preset) => preset.turnPlanner
  },
  embedding: {
    label: "向量模型",
    requiredModelType: "embedding",
    presetField: "embedding",
    getModelRefs: (preset) => preset.embedding
  }
};

const ROUTING_PRESET_FIELDS = Object.values(routingRoleDefinitions)
  .map((definition) => definition.presetField);

function hasPresetField(preset: LlmRoutingPreset, field: RoutingPresetField): boolean {
  return Object.prototype.hasOwnProperty.call(preset, field);
}

function getPresetFieldValue(preset: LlmRoutingPreset, field: RoutingPresetField): string[] | undefined {
  return preset[field];
}

export function createEmptyRoutingPreset(): Required<LlmRoutingPreset> {
  return {
    mainSmall: [],
    mainLarge: [],
    summarizer: [],
    sessionCaptioner: [],
    imageCaptioner: [],
    imageInspector: [],
    audioTranscription: [],
    turnPlanner: [],
    embedding: []
  };
}

export function normalizeRoutingPresetCatalog(
  catalog: Record<string, LlmRoutingPreset>
): Record<string, LlmRoutingPreset> {
  const normalized: Record<string, LlmRoutingPreset> = { ...catalog };
  const defaultPreset = normalized.default;

  if (!defaultPreset) {
    normalized.default = createEmptyRoutingPreset();
    return normalized;
  }

  const completedDefaultPreset = createEmptyRoutingPreset();
  for (const field of ROUTING_PRESET_FIELDS) {
    if (hasPresetField(defaultPreset, field)) {
      completedDefaultPreset[field] = getPresetFieldValue(defaultPreset, field) ?? [];
    }
  }
  normalized.default = completedDefaultPreset;
  return normalized;
}

function createEffectiveRoutingPreset(
  preset: LlmRoutingPreset,
  defaultPreset: Required<LlmRoutingPreset>
): Required<LlmRoutingPreset> {
  const effectivePreset = createEmptyRoutingPreset();
  for (const field of ROUTING_PRESET_FIELDS) {
    if (hasPresetField(preset, field)) {
      effectivePreset[field] = getPresetFieldValue(preset, field) ?? [];
      continue;
    }
    effectivePreset[field] = defaultPreset[field];
  }
  return effectivePreset;
}

export function buildRoutingPresetReferenceCatalog(
  catalog: Record<string, LlmRoutingPreset>
): Record<string, LlmRoutingPreset> {
  const normalizedCatalog = normalizeRoutingPresetCatalog(catalog);
  const defaultPreset = normalizedCatalog.default as Required<LlmRoutingPreset>;
  const referenceCatalog: Record<string, LlmRoutingPreset> = {
    default: createEmptyRoutingPreset()
  };

  for (const presetName of Object.keys(normalizedCatalog)) {
    if (presetName === "default") {
      continue;
    }
    referenceCatalog[presetName] = defaultPreset;
  }

  return referenceCatalog;
}

export function buildEffectiveRoutingPresetCatalog(
  catalog: Record<string, LlmRoutingPreset>
): Record<string, Required<LlmRoutingPreset>> {
  const normalizedCatalog = normalizeRoutingPresetCatalog(catalog);
  const defaultPreset = normalizedCatalog.default as Required<LlmRoutingPreset>;
  const effectiveCatalog: Record<string, Required<LlmRoutingPreset>> = {
    default: defaultPreset
  };

  for (const [presetName, preset] of Object.entries(normalizedCatalog)) {
    if (presetName === "default") {
      continue;
    }
    effectiveCatalog[presetName] = createEffectiveRoutingPreset(preset, defaultPreset);
  }

  return effectiveCatalog;
}

function getDefaultRoutingPreset(config: AppConfig): Required<LlmRoutingPreset> {
  const defaultPreset = normalizeRoutingPresetCatalog(config.llm.routingPresets).default;
  return {
    ...createEmptyRoutingPreset(),
    ...defaultPreset
  };
}

export function getRoutingPresetName(config: AppConfig): string {
  return String(config.llm.routingPreset ?? "").trim();
}

export function getRoutingPreset(config: AppConfig): LlmRoutingPreset | null {
  const presetName = getRoutingPresetName(config);
  if (!presetName) {
    return null;
  }
  return config.llm.routingPresets[presetName] ?? null;
}

export function getEffectiveRoutingPreset(config: AppConfig): Required<LlmRoutingPreset> | null {
  const presetName = getRoutingPresetName(config);
  if (!presetName) {
    return null;
  }

  const preset = config.llm.routingPresets[presetName];
  if (!preset) {
    return null;
  }

  const defaultPreset = getDefaultRoutingPreset(config);
  return createEffectiveRoutingPreset(preset, defaultPreset);
}

export function getModelRefsForRole(config: AppConfig, role: LlmRoutingRole): string[] {
  const preset = getValidatedRoutingPreset(config).preset;
  if (!preset) {
    return [];
  }
  return routingRoleDefinitions[role].getModelRefs(preset) ?? [];
}

export function getPrimaryModelProfileForRole(
  config: AppConfig,
  role: LlmRoutingRole
): ModelProfile | undefined {
  return resolveModelRefsForRole(config, role).primaryProfile;
}

export function resolveModelRefsForRole(
  config: AppConfig,
  role: LlmRoutingRole,
  requiredModelType: SupportedModelType = routingRoleDefinitions[role].requiredModelType
): ResolvedModelRefsForType {
  return resolveModelRefsForType(config, getModelRefsForRole(config, role), requiredModelType);
}

export function getValidatedRoutingPreset(config: AppConfig): RoutingPresetValidationResult {
  const presetName = getRoutingPresetName(config);
  if (!presetName) {
    return {
      presetName,
      preset: null,
      warnings: ["未配置 llm.routingPreset，模型路由 preset 已忽略。"]
    };
  }

  const preset = getEffectiveRoutingPreset(config);
  if (!preset) {
    return {
      presetName,
      preset: null,
      warnings: [`llm.routingPreset=${presetName} 未在 routing preset catalog 中定义，已忽略该 preset。`]
    };
  }

  const warnings: string[] = [];
  for (const role of Object.keys(routingRoleDefinitions) as LlmRoutingRole[]) {
    const roleDefinition = routingRoleDefinitions[role];
    const resolved = resolveModelRefsForType(
      config,
      roleDefinition.getModelRefs(preset) ?? [],
      roleDefinition.requiredModelType
    );
    for (const rejected of resolved.rejectedModelRefs) {
      if (rejected.reason === "unknown_model") {
        warnings.push(
          `routing preset ${presetName} 的角色 ${roleDefinition.label} 引用了未知模型 ${rejected.modelRef}，该模型已忽略。`
        );
        continue;
      }
      warnings.push(
        `routing preset ${presetName} 的角色 ${roleDefinition.label} 引用了模型 ${rejected.modelRef}，其模型类型为 ${rejected.actualModelType ?? "unknown"}，期望 ${roleDefinition.requiredModelType}，该模型已忽略。`
      );
    }
  }

  return {
    presetName,
    preset,
    warnings
  };
}
