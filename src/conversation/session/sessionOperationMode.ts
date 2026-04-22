import type { ScenarioProfile } from "#modes/scenarioHost/profileSchema.ts";
import type { RpProfile } from "#modes/rpAssistant/profileSchema.ts";
import type { Persona } from "#persona/personaSchema.ts";

export type SessionOperationModeProfileId = "rp_assistant" | "scenario_host";

export type SessionOperationMode =
  | { kind: "normal" }
  | { kind: "persona_setup"; draft: Persona }
  | { kind: "mode_setup"; modeId: SessionOperationModeProfileId; draft: RpProfile | ScenarioProfile }
  | { kind: "persona_config"; draft: Persona }
  | { kind: "mode_config"; modeId: SessionOperationModeProfileId; draft: RpProfile | ScenarioProfile };

export function createNormalSessionOperationMode(): SessionOperationMode {
  return { kind: "normal" };
}

export function cloneSessionOperationMode(operationMode: SessionOperationMode): SessionOperationMode {
  if (operationMode.kind === "normal") {
    return createNormalSessionOperationMode();
  }
  return {
    ...operationMode,
    draft: { ...operationMode.draft }
  } as SessionOperationMode;
}
