import type { AppConfig } from "#config/config.ts";
import { getBuiltinToolNames } from "#llm/builtinTools.ts";
import type { BuiltinToolContext, Relationship, ToolVisibilityContext } from "./core/shared.ts";
import { getDefaultSessionModeId, requireSessionModeDefinition } from "#modes/registry.ts";
import type { SessionModeSetupToolsetOverride } from "#modes/types.ts";
import { TOOLSET_DEFINITIONS, toToolsetView } from "./toolsetCatalog.ts";
import type { ToolsetView } from "./toolsetCatalog.ts";
import type { ProfileToolScope } from "./profileToolScope.ts";
import {
  createDefaultSessionToolsetPreferences,
  resolveSessionToolsetEnabled,
  type SessionToolsetOverride,
  type SessionToolsetPreferences
} from "#conversation/session/sessionToolsetPreferences.ts";

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
  setupPhase?: {
    setupToolsetOverrides: SessionModeSetupToolsetOverride[];
  };
  modeId?: string;
  profileToolScope?: ProfileToolScope | null;
  visibilityContext?: ToolVisibilityContext;
  toolsetPreferences?: SessionToolsetPreferences;
}

export interface ConfigurableSessionToolset {
  id: string;
  title: string;
  description: string;
  toolNames: string[];
  defaultEnabled: boolean;
  effectiveEnabled: boolean;
  override: SessionToolsetOverride | null;
  ownerOnly: boolean;
  debugOnly: boolean;
}

const KNOWN_TOOLSET_IDS = new Set(TOOLSET_DEFINITIONS.map((toolset) => toolset.id));

export function normalizeSessionToolsetPreferences(
  preferences: SessionToolsetPreferences
): SessionToolsetPreferences {
  return {
    overrides: Object.fromEntries(
      Object.entries(preferences.overrides).filter(([toolsetId]) => KNOWN_TOOLSET_IDS.has(toolsetId))
    )
  };
}

export function findUnknownSessionToolsetOverride(
  preferences: SessionToolsetPreferences
): string | null {
  return Object.keys(preferences.overrides).find((toolsetId) => !KNOWN_TOOLSET_IDS.has(toolsetId)) ?? null;
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
      includeDebugTools: input.includeDebugTools,
      ...(input.visibilityContext ? { visibilityContext: input.visibilityContext } : {}),
      ...(input.profileToolScope !== undefined ? { profileToolScope: input.profileToolScope } : {})
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

  if (input.profileToolScope && input.profileToolScope !== "normal") {
    return buildProfileDraftToolsets(
      input.profileToolScope,
      visibleToolNames,
      visibleSharedToolsets,
      input.relationship,
      input.includeDebugTools
    );
  }

  const modeId = input.modeId ?? getDefaultSessionModeId();
  const modeDefaults = resolveModeToolsetDefaults(modeId);
  const preferences = input.toolsetPreferences ?? createDefaultSessionToolsetPreferences();
  return TOOLSET_DEFINITIONS
    .filter((toolset) => {
      const defaultEnabled = modeDefaults.get(toolset.id);
      return defaultEnabled != null
        && resolveSessionToolsetEnabled(preferences, toolset.id, defaultEnabled);
    })
    .filter((toolset) => isToolsetVisible(toolset, input.relationship, input.includeDebugTools))
    .map((toolset) => toToolsetView(toolset, visibleToolNames))
    .filter((toolset): toolset is ToolsetView => toolset != null);
}

export function listConfigurableSessionToolsets(
  modeId: string,
  preferences: SessionToolsetPreferences
): ConfigurableSessionToolset[] {
  const modeDefaults = resolveModeToolsetDefaults(modeId);
  return TOOLSET_DEFINITIONS.flatMap((toolset) => {
    const defaultEnabled = modeDefaults.get(toolset.id);
    if (defaultEnabled == null) {
      return [];
    }
    const override = preferences.overrides[toolset.id] ?? null;
    return [{
      id: toolset.id,
      title: toolset.title,
      description: toolset.description,
      toolNames: [...toolset.toolNames],
      defaultEnabled,
      effectiveEnabled: resolveSessionToolsetEnabled(preferences, toolset.id, defaultEnabled),
      override,
      ownerOnly: toolset.ownerOnly === true,
      debugOnly: toolset.debugOnly === true
    }];
  });
}

function resolveModeToolsetDefaults(modeId: string): Map<string, boolean> {
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
    .filter((toolset) => toolset.modeUniversal?.defaultEnabled === true)
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
        ...(item.plannerSignals && item.plannerSignals.length > 0 ? { plannerSignals: item.plannerSignals } : {})
      }))
      .filter((toolset) => toolset.toolNames.length > 0),
    ...visibleSharedToolsets.filter((toolset) => !overrideIds.has(toolset.id))
  ];
}

function buildProfileDraftToolsets(
  scope: Exclude<ProfileToolScope, "normal">,
  visibleToolNames: Set<string>,
  visibleSharedToolsets: ToolsetView[],
  relationship: Relationship,
  includeDebugTools: boolean
): ToolsetView[] {
  const toolsetId = scope === "persona"
    ? "persona_profile_draft"
    : scope === "rp"
      ? "rp_profile_draft"
      : "scenario_profile_draft";
  const toolset = TOOLSET_DEFINITIONS.find((item) => item.id === toolsetId);
  if (!toolset || !isToolsetVisible(toolset, relationship, includeDebugTools)) {
    return visibleSharedToolsets;
  }
  const draftToolset = toToolsetView(toolset, visibleToolNames);
  return draftToolset ? [draftToolset, ...visibleSharedToolsets] : visibleSharedToolsets;
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
