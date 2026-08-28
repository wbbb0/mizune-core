import type { AppConfig } from "#config/config.ts";
import { getModelRefsForRole } from "./modelRouting.ts";
import { normalizeModelRefs } from "./modelProfiles.ts";

export const MODEL_SELF_UPGRADE_TOOL_NAME = "request_model_upgrade";

export interface ModelSelfUpgradePlan {
  fromRole: "main_small";
  toRole: "main_large";
  smallModelRefs: string[];
  largeModelRefs: string[];
  provider: string;
}

export function resolveModelSelfUpgradePlan(input: {
  config: AppConfig;
  currentModelRefs: string | string[];
  enabled: boolean;
}): ModelSelfUpgradePlan | null {
  if (!input.enabled || !input.config.llm.enabled) {
    return null;
  }

  const currentModelRefs = normalizeModelRefs(input.currentModelRefs);
  const smallModelRefs = normalizeModelRefs(getModelRefsForRole(input.config, "main_small"));
  const largeModelRefs = normalizeModelRefs(getModelRefsForRole(input.config, "main_large"));
  if (
    smallModelRefs.length === 0
    || largeModelRefs.length === 0
    || !sameModelRefs(currentModelRefs, smallModelRefs)
  ) {
    return null;
  }

  const allModelRefs = [...smallModelRefs, ...largeModelRefs];
  const profiles = allModelRefs.map((modelRef) => input.config.llm.models[modelRef]);
  if (profiles.some((profile) => (
    profile == null
    || profile.modelType !== "chat"
    || profile.supportsTools !== true
  ))) {
    return null;
  }

  const provider = profiles[0]?.provider;
  if (
    !provider
    || input.config.llm.providers[provider] == null
    || profiles.some((profile) => profile?.provider !== provider)
  ) {
    return null;
  }

  const smallPrimaryModel = profiles[0]?.model;
  const largePrimaryModel = input.config.llm.models[largeModelRefs[0]!]?.model;
  if (!smallPrimaryModel || !largePrimaryModel || smallPrimaryModel === largePrimaryModel) {
    return null;
  }

  return {
    fromRole: "main_small",
    toRole: "main_large",
    smallModelRefs,
    largeModelRefs,
    provider
  };
}

export function sameModelRefs(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
