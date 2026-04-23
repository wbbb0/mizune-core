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
  | "audio_transcription"
  | "turn_planner";

interface RoutingRoleDefinition {
  label: string;
  requiredModelType: SupportedModelType;
  getModelRefs: (preset: LlmRoutingPreset) => string[];
}

export interface RoutingPresetValidationResult {
  presetName: string;
  preset: LlmRoutingPreset | null;
  warnings: string[];
}

const routingRoleDefinitions: Record<LlmRoutingRole, RoutingRoleDefinition> = {
  main_small: {
    label: "主路由轻量模型",
    requiredModelType: "chat",
    getModelRefs: (preset) => preset.mainSmall
  },
  main_large: {
    label: "主路由完整模型",
    requiredModelType: "chat",
    getModelRefs: (preset) => preset.mainLarge
  },
  summarizer: {
    label: "总结器",
    requiredModelType: "chat",
    getModelRefs: (preset) => preset.summarizer
  },
  session_captioner: {
    label: "会话标题生成",
    requiredModelType: "chat",
    getModelRefs: (preset) => preset.sessionCaptioner
  },
  image_captioner: {
    label: "图片描述",
    requiredModelType: "chat",
    getModelRefs: (preset) => preset.imageCaptioner
  },
  audio_transcription: {
    label: "音频转写",
    requiredModelType: "transcription",
    getModelRefs: (preset) => preset.audioTranscription
  },
  turn_planner: {
    label: "轮次规划",
    requiredModelType: "chat",
    getModelRefs: (preset) => preset.turnPlanner
  }
};

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

export function getModelRefsForRole(config: AppConfig, role: LlmRoutingRole): string[] {
  const preset = getValidatedRoutingPreset(config).preset;
  if (!preset) {
    return [];
  }
  return routingRoleDefinitions[role].getModelRefs(preset);
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

  const preset = config.llm.routingPresets[presetName];
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
      roleDefinition.getModelRefs(preset),
      roleDefinition.requiredModelType
    );
    if (resolved.acceptedModelRefs.length === 0) {
      warnings.push(
        `routing preset ${presetName} 的角色 ${roleDefinition.label} 没有可用模型，已忽略该 preset。`
      );
      continue;
    }
    for (const rejected of resolved.rejectedModelRefs) {
      if (rejected.reason === "unknown_model") {
        warnings.push(
          `routing preset ${presetName} 的角色 ${roleDefinition.label} 引用了未知模型 ${rejected.modelRef}，已忽略该 preset。`
        );
        continue;
      }
      warnings.push(
        `routing preset ${presetName} 的角色 ${roleDefinition.label} 引用了模型 ${rejected.modelRef}，其模型类型为 ${rejected.actualModelType ?? "unknown"}，期望 ${roleDefinition.requiredModelType}，已忽略该 preset。`
      );
    }
  }

  if (warnings.length > 0) {
    return {
      presetName,
      preset: null,
      warnings
    };
  }

  return {
    presetName,
    preset,
    warnings
  };
}
