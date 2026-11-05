import type { SessionOperationMode } from "#conversation/session/sessionOperationMode.ts";
import { isSkillRuntimeAllowedForSession, SKILL_TOOL_NAMES } from "../../skills/skillPolicy.ts";
import { resolveSessionModeSetupOperation } from "#modes/types.ts";
import { resolveProfileToolScopeFromOperationMode } from "./profileToolScope.ts";
import { requireSessionModeDefinition } from "#modes/registry.ts";
import { TOOLSET_DEFINITIONS } from "./toolsetCatalog.ts";
import { resolveSessionToolsetEnabled, type SessionToolsetPreferences } from "#conversation/session/sessionToolsetPreferences.ts";

export function resolveModeToolsetDefaults(modeId: string): Map<string, boolean> {
  const mode = requireSessionModeDefinition(modeId);
  const defaults = new Map<string, boolean>();
  for (const toolset of TOOLSET_DEFINITIONS) {
    if (toolset.modeUniversal) {
      defaults.set(toolset.id, toolset.modeUniversal.defaultEnabled);
    }
  }
  for (const policy of mode.toolsets) {
    defaults.set(policy.toolsetId, policy.defaultEnabled);
  }
  return defaults;
}


/** Mode/preferences boundary only; connector and actor checks belong to availability. */
export function resolveSessionBoundaryToolNames(
  modeId: string,
  preferences: SessionToolsetPreferences,
  operationMode?: SessionOperationMode
): Set<string> {
  const mode = requireSessionModeDefinition(modeId);
  const setup = operationMode && operationMode.kind !== "normal"
    ? resolveSessionModeSetupOperation(mode.setupPhase, operationMode.kind) : null;
  const profileScope = resolveProfileToolScopeFromOperationMode(operationMode);
  const inProfile = profileScope != null && profileScope !== "normal";
  if (setup || inProfile) {
    const shared = TOOLSET_DEFINITIONS.filter((toolset) =>
      (toolset.modeUniversal?.defaultEnabled === true || toolset.availableDuringSetup === true)
      && resolveSessionToolsetEnabled(preferences, toolset.id, true));
    if (setup) {
      const overrides = setup.setupToolsetOverrides ?? [];
      const overridden = new Set(overrides.map((item) => item.toolsetId));
      return new Set([
        ...overrides.flatMap((item) => item.toolNames),
        ...shared.filter((item) => !overridden.has(item.id)).flatMap((item) => item.toolNames)
      ]);
    }
    const draftId = profileScope === "persona" ? "persona_profile_draft"
      : profileScope === "rp" ? "rp_profile_draft" : "scenario_profile_draft";
    return new Set([
      ...shared.flatMap((item) => item.toolNames),
      ...TOOLSET_DEFINITIONS.filter((item) => item.id === draftId).flatMap((item) => item.toolNames)
    ]);
  }
  const defaults = resolveModeToolsetDefaults(modeId);
  return new Set(TOOLSET_DEFINITIONS.filter((toolset) => {
    const enabled = defaults.get(toolset.id);
    return enabled != null && resolveSessionToolsetEnabled(preferences, toolset.id, enabled);
  }).flatMap((toolset) => toolset.toolNames).concat(
    isSkillRuntimeAllowedForSession(modeId, operationMode) ? SKILL_TOOL_NAMES : []
  ));
}
