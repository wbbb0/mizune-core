import type { LlmRoutingPreset } from "#config/configModel.ts";
import {
  buildEffectiveRoutingPresetCatalog,
  buildRoutingPresetReferenceCatalog,
  normalizeRoutingPresetCatalog
} from "#llm/shared/modelRouting.ts";

export type EditorDraftEffectiveMode =
  | "draft_only"
  | "merge_reference"
  | "record_inheritance";

export type EditorUnsetMode =
  | "disabled"
  | "optional"
  | "reference";

export interface EditorFeatures {
  showReferenceBackdrop: boolean;
  unsetMode: EditorUnsetMode;
  unsetActionLabel: string | null;
  draftEffectiveMode: EditorDraftEffectiveMode;
  recordInheritance?: { sourceKey: string; defaults: Record<string, unknown> };
}

export interface EditorValueState<TValue = unknown> {
  currentValue: TValue;
  referenceValue: unknown;
  effectiveValue: unknown;
}

export function createEditorFeatures(
  overrides: Partial<EditorFeatures> = {}
): EditorFeatures {
  return {
    showReferenceBackdrop: false,
    unsetMode: "disabled",
    unsetActionLabel: null,
    draftEffectiveMode: "draft_only",
    ...overrides
  };
}

export function createDraftOnlyEditorValueState<TValue>(
  currentValue: TValue
): EditorValueState<TValue> {
  return {
    currentValue,
    referenceValue: undefined,
    effectiveValue: currentValue
  };
}

export function createRoutingPresetCatalogEditorValueState(
  currentValue: Record<string, LlmRoutingPreset>
): EditorValueState<Record<string, LlmRoutingPreset>> {
  const normalizedCurrentValue = normalizeRoutingPresetCatalog(currentValue);
  return {
    currentValue: normalizedCurrentValue,
    referenceValue: buildRoutingPresetReferenceCatalog(normalizedCurrentValue),
    effectiveValue: buildEffectiveRoutingPresetCatalog(normalizedCurrentValue)
  };
}

export function createRoutingPresetEditorFeatures(): EditorFeatures {
  return createEditorFeatures({
    unsetMode: "reference",
    unsetActionLabel: "回退到 default",
    draftEffectiveMode: "record_inheritance",
    recordInheritance: {
      sourceKey: "default",
      defaults: { ...normalizeRoutingPresetCatalog({}).default }
    }
  });
}
