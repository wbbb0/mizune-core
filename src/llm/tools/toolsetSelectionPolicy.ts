import type { AppConfig } from "#config/config.ts";
import { getBuiltinToolNames } from "#llm/builtinTools.ts";
import type { BuiltinToolContext, Relationship } from "./core/shared.ts";
import { getDefaultSessionModeId, requireSessionModeDefinition } from "#modes/registry.ts";
import type { SessionModeSetupPhase, SessionModeSetupToolsetOverride } from "#modes/types.ts";
import { TOOLSET_DEFINITIONS, toToolsetView } from "./toolsetCatalog.ts";
import type { ToolsetView } from "./toolsetCatalog.ts";

export const TURN_PLANNER_ALWAYS_TOOL_NAMES = [
  "list_available_toolsets",
  "request_toolset"
] as const;

export interface TurnToolsetSelectionInput {
  config: AppConfig;
  relationship: Relationship;
  currentUser: BuiltinToolContext["currentUser"];
  modelRef: string[];
  includeDebugTools: boolean;
  setupPhase?: Pick<SessionModeSetupPhase, "setupToolsetOverrides">;
  modeId?: string;
}

// Centralizes runtime toolset visibility and setup override policy so the catalog
// stays declarative and callers do not need to rebuild these filters ad hoc.
export function listTurnToolsets(input: TurnToolsetSelectionInput): ToolsetView[] {
  const visibleToolNames = new Set(getBuiltinToolNames(
    input.relationship,
    input.currentUser,
    input.config,
    {
      modelRef: input.modelRef,
      includeDebugTools: input.includeDebugTools
    }
  ));
  const visibleSharedToolsets = listVisibleSharedToolsets(visibleToolNames, input.relationship, input.includeDebugTools);

  if (input.setupPhase) {
    return applySetupToolsetOverrides(
      input.setupPhase.setupToolsetOverrides ?? [],
      visibleToolNames,
      visibleSharedToolsets
    );
  }

  const mode = requireSessionModeDefinition(input.modeId ?? getDefaultSessionModeId());
  return TOOLSET_DEFINITIONS
    .filter((toolset) => toolset.modeUniversal === true || mode.defaultToolsetIds.includes(toolset.id))
    .filter((toolset) => isToolsetVisible(toolset, input.relationship, input.includeDebugTools))
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

function listVisibleSharedToolsets(
  visibleToolNames: Set<string>,
  relationship: Relationship,
  includeDebugTools: boolean
): ToolsetView[] {
  return TOOLSET_DEFINITIONS
    .filter((toolset) => toolset.modeUniversal === true)
    .filter((toolset) => isToolsetVisible(toolset, relationship, includeDebugTools))
    .map((toolset) => toToolsetView(toolset, visibleToolNames))
    .filter((toolset): toolset is ToolsetView => toolset != null);
}

function applySetupToolsetOverrides(
  overrides: SessionModeSetupToolsetOverride[],
  visibleToolNames: Set<string>,
  visibleSharedToolsets: ToolsetView[]
): ToolsetView[] {
  if (overrides.length === 0) {
    return visibleSharedToolsets;
  }
  const overrideIds = new Set(overrides.map((item) => item.toolsetId));
  return [
    ...overrides
      .map((item) => ({
        id: item.toolsetId,
        title: item.title ?? item.toolsetId,
        description: item.description ?? "",
        toolNames: item.toolNames.filter((toolName) => visibleToolNames.has(toolName)),
        ...(item.promptGuidance && item.promptGuidance.length > 0 ? { promptGuidance: item.promptGuidance } : {}),
        ...(item.plannerSignals && item.plannerSignals.length > 0 ? { plannerSignals: item.plannerSignals } : {})
      }))
      .filter((toolset) => toolset.toolNames.length > 0),
    ...visibleSharedToolsets.filter((toolset) => !overrideIds.has(toolset.id))
  ];
}

function isToolsetVisible(
  toolset: { ownerOnly?: boolean; debugOnly?: boolean },
  relationship: Relationship,
  includeDebugTools: boolean
): boolean {
  if (toolset.ownerOnly && relationship !== "owner") {
    return false;
  }
  if (toolset.debugOnly && !includeDebugTools) {
    return false;
  }
  return true;
}
