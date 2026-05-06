export interface EditorResourceSummary {
  key: string;
  title: string;
  domain: "config" | "data";
  kind: "single" | "layered";
  editable: boolean;
}

export interface SchemaMeta {
  kind: string;
  title?: string;
  description?: string;
  optional: boolean;
  hasDefault: boolean;
  defaultValue?: unknown;
  fields?: Record<string, SchemaMeta>;
  unknownKeys?: string;
  item?: SchemaMeta;
  key?: SchemaMeta;
  recordValue?: SchemaMeta;
  options?: SchemaMeta[];
  values?: unknown[];
  integer?: boolean;
  min?: number;
  max?: number;
  value?: unknown;
  dynamicRef?: string;
}

export type UiNode =
  | { kind: "field"; schema: SchemaMeta }
  | { kind: "group"; schema: SchemaMeta; children: Record<string, UiNode> }
  | { kind: "array"; schema: SchemaMeta; item: UiNode }
  | { kind: "record"; schema: SchemaMeta; key: UiNode; value: UiNode }
  | { kind: "union"; schema: SchemaMeta; options: UiNode[] };

export interface LayerInfo {
  key: string;
  path: string;
  value: unknown;
}

export type EditorDraftEffectiveMode =
  | "draft_only"
  | "merge_reference"
  | "routing_preset_catalog";

export type EditorUnsetMode =
  | "disabled"
  | "optional"
  | "reference";

export interface EditorFeatures {
  showReferenceBackdrop: boolean;
  unsetMode: EditorUnsetMode;
  unsetActionLabel: string | null;
  draftEffectiveMode: EditorDraftEffectiveMode;
}

interface BaseEditorModel {
  key: string;
  title: string;
  editable: boolean;
  schemaMeta: SchemaMeta;
  uiTree: UiNode;
  template: unknown;
  currentValue: unknown;
  referenceValue: unknown;
  effectiveValue: unknown;
  editorFeatures: EditorFeatures;
}

export interface SingleEditorModel extends BaseEditorModel {
  kind: "single";
  file: { path: string };
}

export interface LayeredEditorModel extends BaseEditorModel {
  kind: "layered";
  writableLayerKey: string;
  layers: LayerInfo[];
}

export type EditorModel = SingleEditorModel | LayeredEditorModel;

export type ResourceEditorValidateResult = {
  ok: true;
  parsed: unknown;
  currentValue: unknown;
  referenceValue: unknown;
  effective: unknown;
};

export type ResourceEditorSaveResult = {
  ok: true;
  path: string;
  parsed: unknown;
};

export interface ResourceEditorClient {
  list(): Promise<{ resources: EditorResourceSummary[] }>;
  load(key: string): Promise<{ editor: EditorModel }>;
  validate(key: string, value: unknown): Promise<ResourceEditorValidateResult>;
  save(key: string, value: unknown): Promise<ResourceEditorSaveResult>;
  options?(key: string): Promise<{ options: string[] }>;
}
