import { api } from "./client";

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
  // object
  fields?: Record<string, SchemaMeta>;
  unknownKeys?: string;
  // array
  item?: SchemaMeta;
  // record
  key?: SchemaMeta;
  recordValue?: SchemaMeta;
  // union
  options?: SchemaMeta[];
  // enum
  values?: unknown[];
  // number
  integer?: boolean;
  min?: number;
  max?: number;
  // literal
  value?: unknown;
  // string dynamic ref
  dynamicRef?: string;
}

export type UiNode =
  | { kind: "field";  schema: SchemaMeta }
  | { kind: "group";  schema: SchemaMeta; children: Record<string, UiNode> }
  | { kind: "array";  schema: SchemaMeta; item: UiNode }
  | { kind: "record"; schema: SchemaMeta; key: UiNode; value: UiNode }
  | { kind: "union";  schema: SchemaMeta; options: UiNode[] };

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

export const editorApi = {
  list(): Promise<{ resources: EditorResourceSummary[] }> {
    return api.get("/api/editors");
  },
  load(key: string): Promise<{ editor: EditorModel }> {
    return api.get(`/api/editors/${encodeURIComponent(key)}`);
  },
  validate(key: string, value: unknown): Promise<{ ok: true; parsed: unknown; currentValue: unknown; referenceValue: unknown; effective: unknown }> {
    return api.post(`/api/editors/${encodeURIComponent(key)}/validate`, { value });
  },
  save(key: string, value: unknown): Promise<{ ok: true; path: string; parsed: unknown }> {
    return api.post(`/api/editors/${encodeURIComponent(key)}/save`, { value });
  },
  options(key: string): Promise<{ options: string[] }> {
    return api.get(`/api/editor-options/${encodeURIComponent(key)}`);
  }
};
