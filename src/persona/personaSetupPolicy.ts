import type { AppConfig } from "#config/config.ts";
import type { GlobalProfileReadinessStatus } from "#identity/globalProfileReadinessSchema.ts";
import { isPersonaComplete, type Persona } from "./personaSchema.ts";

export function shouldSkipPersonaInitialization(config?: Pick<AppConfig, "conversation">): boolean {
  return config?.conversation?.setup?.skipPersonaInitialization === true;
}

export function resolvePersonaReadinessStatus(
  config: Pick<AppConfig, "conversation"> | undefined,
  persona: Persona
): GlobalProfileReadinessStatus {
  if (shouldSkipPersonaInitialization(config)) {
    return "ready";
  }
  return isPersonaComplete(persona) ? "ready" : "uninitialized";
}

export function isPersonaInitializationRequired(
  config: Pick<AppConfig, "conversation"> | undefined,
  persona: Persona
): boolean {
  return resolvePersonaReadinessStatus(config, persona) !== "ready";
}
