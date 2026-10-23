import type { ScenarioProfile } from "#modes/scenarioHost/profileSchema.ts";
import type { RpProfile } from "#modes/rpAssistant/profileSchema.ts";
import type { Persona } from "#persona/personaSchema.ts";

export type SessionOperationModeProfileId = "rp_assistant" | "scenario_host";

export type SessionRpProfileOperationMode =
  | { kind: "mode_setup"; modeId: "rp_assistant"; draft: RpProfile }
  | { kind: "mode_config"; modeId: "rp_assistant"; draft: RpProfile };

export type SessionScenarioProfileOperationMode =
  | { kind: "mode_setup"; modeId: "scenario_host"; draft: ScenarioProfile }
  | { kind: "mode_config"; modeId: "scenario_host"; draft: ScenarioProfile };

export type SessionProfileOperationMode =
  | SessionRpProfileOperationMode
  | SessionScenarioProfileOperationMode;

export type SessionOperationMode =
  | { kind: "normal" }
  | { kind: "character_config"; stage: "persona" | "social" | "embodiment" | "state" }
  | { kind: "skill_config"; skillId: string }
  | { kind: "persona_setup"; draft: Persona }
  | SessionProfileOperationMode
  | { kind: "persona_config"; draft: Persona }
  | SessionProfileOperationMode;

export type SessionProfilePhaseTarget = "persona" | "rp" | "scenario";
export type SessionProfilePhase = "setup" | "config";

export function createNormalSessionOperationMode(): SessionOperationMode {
  return { kind: "normal" };
}

export function getSessionOperationProfilePhase(
  operationMode: SessionOperationMode
): { target: SessionProfilePhaseTarget; phase: SessionProfilePhase } | null {
  switch (operationMode.kind) {
    case "persona_setup":
      return { target: "persona", phase: "setup" };
    case "persona_config":
      return { target: "persona", phase: "config" };
    case "mode_setup":
      return {
        target: operationMode.modeId === "rp_assistant" ? "rp" : "scenario",
        phase: "setup"
      };
    case "mode_config":
      return {
        target: operationMode.modeId === "rp_assistant" ? "rp" : "scenario",
        phase: "config"
      };
    case "character_config":
    case "skill_config":
    case "normal":
      return null;
  }
}

export function cloneSessionOperationMode(operationMode: SessionOperationMode): SessionOperationMode {
  if (operationMode.kind === "normal") {
    return createNormalSessionOperationMode();
  }
  if (operationMode.kind === "skill_config" || operationMode.kind === "character_config") return { ...operationMode };
  if (operationMode.kind === "persona_setup" || operationMode.kind === "persona_config") {
    return {
      ...operationMode,
      draft: { ...operationMode.draft }
    };
  }
  if (operationMode.modeId === "rp_assistant") {
    return {
      ...operationMode,
      draft: { ...operationMode.draft }
    };
  }
  return {
    ...operationMode,
    draft: { ...operationMode.draft }
  };
}
