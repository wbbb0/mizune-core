import type { SessionOperationMode } from "#conversation/session/sessionOperationMode.ts";

export type ProfileToolScope = "normal" | "persona" | "rp" | "scenario";

export const personaProfileToolNames = [
  "get_persona",
  "patch_persona",
  "clear_persona_field"
] as const;

export const rpProfileToolNames = [
  "get_rp_profile",
  "patch_rp_profile",
  "clear_rp_profile_field"
] as const;

export const scenarioProfileToolNames = [
  "get_scenario_profile",
  "patch_scenario_profile",
  "clear_scenario_profile_field"
] as const;

export function resolveProfileToolScopeFromOperationMode(
  operationMode: SessionOperationMode | undefined
): ProfileToolScope | null {
  if (!operationMode) {
    return null;
  }
  if (operationMode.kind === "normal") {
    return "normal";
  }
  if (operationMode.kind === "persona_setup" || operationMode.kind === "persona_config") {
    return "persona";
  }
  return operationMode.modeId === "rp_assistant" ? "rp" : "scenario";
}

export function filterProfileToolNamesForScope(
  toolNames: Iterable<string>,
  scope: ProfileToolScope | null | undefined
): string[] {
  if (!scope) {
    return Array.from(toolNames);
  }
  const visibleNames = new Set(toolNames);
  const deleteNames = (names: readonly string[]) => {
    for (const name of names) {
      visibleNames.delete(name);
    }
  };

  if (scope === "normal") {
    deleteNames(personaProfileToolNames.filter((name) => name !== "get_persona"));
    deleteNames(rpProfileToolNames);
    deleteNames(scenarioProfileToolNames);
    return Array.from(visibleNames);
  }

  if (scope === "persona") {
    deleteNames(rpProfileToolNames);
    deleteNames(scenarioProfileToolNames);
    return Array.from(visibleNames);
  }

  if (scope === "rp") {
    deleteNames(personaProfileToolNames);
    deleteNames(scenarioProfileToolNames);
    return Array.from(visibleNames);
  }

  deleteNames(personaProfileToolNames);
  deleteNames(rpProfileToolNames);
  return Array.from(visibleNames);
}
