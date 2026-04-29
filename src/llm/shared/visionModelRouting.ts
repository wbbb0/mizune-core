import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { resolveModelRefsForType } from "./modelProfiles.ts";
import { getModelRefsForRole, type LlmRoutingRole } from "./modelRouting.ts";

export interface VisionInputModelRoute {
  modelRefs: string[];
  ignoredModelRefs: string[];
}

export function getVisionInputModelRefsForRole(
  config: AppConfig,
  role: LlmRoutingRole
): VisionInputModelRoute {
  return getVisionInputModelRefs(config, getModelRefsForRole(config, role));
}

export function getVisionInputModelRefs(
  config: AppConfig,
  modelRef: string | string[]
): VisionInputModelRoute {
  const resolved = resolveModelRefsForType(config, modelRef, "chat");
  const modelRefs: string[] = [];
  const ignoredModelRefs: string[] = [];

  for (const modelRef of resolved.acceptedModelRefs) {
    const profile = config.llm.models[modelRef];
    if (profile?.supportsVision === true) {
      modelRefs.push(modelRef);
      continue;
    }
    ignoredModelRefs.push(modelRef);
  }

  return { modelRefs, ignoredModelRefs };
}

export function hasVisionInputModelRef(
  config: AppConfig,
  modelRef: string | string[]
): boolean {
  return getVisionInputModelRefs(config, modelRef).modelRefs.length > 0;
}

export function resolveVisionInputModelRefsForRole(input: {
  config: AppConfig;
  role: LlmRoutingRole;
  logger: Pick<Logger, "warn">;
  warningCache: Set<string>;
}): string[] {
  const route = getVisionInputModelRefsForRole(input.config, input.role);
  const freshIgnored = route.ignoredModelRefs.filter((modelRef) => {
    const cacheKey = `${input.role}:${modelRef}`;
    if (input.warningCache.has(cacheKey)) {
      return false;
    }
    input.warningCache.add(cacheKey);
    return true;
  });

  if (freshIgnored.length > 0) {
    input.logger.warn({
      role: input.role,
      modelRefs: freshIgnored,
      reason: "supportsVision=false"
    }, "vision_model_ref_ignored");
  }

  return route.modelRefs;
}
