import type { AppConfig } from "#config/config.ts";
import { getBuiltinToolNames } from "#llm/builtinTools.ts";
import type { BuiltinToolContext, Relationship } from "./core/shared.ts";
import { getDefaultSessionModeId, requireSessionModeDefinition } from "#modes/registry.ts";
import type { SessionModeSetupPhase } from "#modes/types.ts";
import { TOOLSET_DEFINITIONS, toToolsetView } from "./toolsetCatalog.ts";
import type { ToolsetView } from "./toolsetCatalog.ts";
export type { ToolsetDefinition, ToolsetView } from "./toolsetCatalog.ts";

export const TURN_PLANNER_ALWAYS_TOOL_NAMES = [
  "list_available_toolsets",
  "request_toolset"
] as const;

export function listTurnToolsets(input: {
  config: AppConfig;
  relationship: Relationship;
  currentUser: BuiltinToolContext["currentUser"];
  modelRef: string[];
  includeDebugTools: boolean;
  setupPhase?: Pick<SessionModeSetupPhase, "setupToolsetOverrides">;
  modeId?: string;
}): ToolsetView[] {
  const visibleToolNames = new Set(getBuiltinToolNames(
    input.relationship,
    input.currentUser,
    input.config,
    {
      modelRef: input.modelRef,
      includeDebugTools: input.includeDebugTools
    }
  ));
  const mode = requireSessionModeDefinition(input.modeId ?? getDefaultSessionModeId());
  const defaultModeToolsetIds = new Set(mode.defaultToolsetIds);
  const visibleSharedToolsets = TOOLSET_DEFINITIONS
    .filter((toolset) => toolset.modeUniversal === true)
    .filter((toolset) => !(toolset.ownerOnly && input.relationship !== "owner"))
    .filter((toolset) => !(toolset.debugOnly && !input.includeDebugTools))
    .map((toolset) => toToolsetView(toolset, visibleToolNames))
    .filter((toolset): toolset is ToolsetView => toolset != null);

  if (input.setupPhase) {
    const overrides = input.setupPhase.setupToolsetOverrides ?? [];
    if (overrides.length > 0) {
      const overrideIds = new Set(overrides.map((o) => o.toolsetId));
      return [
        ...overrides
          .map((o) => ({
            id: o.toolsetId,
            title: o.title ?? o.toolsetId,
            description: o.description ?? "",
            toolNames: o.toolNames.filter((n) => visibleToolNames.has(n)),
            ...(o.promptGuidance && o.promptGuidance.length > 0 ? { promptGuidance: o.promptGuidance } : {}),
            ...(o.plannerSignals && o.plannerSignals.length > 0 ? { plannerSignals: o.plannerSignals } : {})
          }))
          .filter((t) => t.toolNames.length > 0),
        ...visibleSharedToolsets.filter((t) => !overrideIds.has(t.id))
      ];
    }
    return visibleSharedToolsets;
  }

  return TOOLSET_DEFINITIONS
    .filter((toolset) => toolset.modeUniversal === true || defaultModeToolsetIds.has(toolset.id))
    .filter((toolset) => !(toolset.ownerOnly && input.relationship !== "owner"))
    .filter((toolset) => !(toolset.debugOnly && !input.includeDebugTools))
    .map((toolset) => toToolsetView(toolset, visibleToolNames))
    .filter((toolset): toolset is ToolsetView => toolset != null);
}

export function resolveToolNamesFromToolsets(
  toolsets: ToolsetView[],
  selectedToolsetIds: string[]
): string[] {
  const selectedSet = new Set(selectedToolsetIds);
  return Array.from(new Set(
    toolsets
      .filter((toolset) => selectedSet.has(toolset.id))
      .flatMap((toolset) => toolset.toolNames)
  ));
}
