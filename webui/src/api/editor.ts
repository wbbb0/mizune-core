import { api } from "./client";
import type {
  EditorModel,
  EditorResourceSummary,
  ResourceEditorClient,
  ResourceEditorSaveResult,
  ResourceEditorValidateResult
} from "@workbench-kit/vue-resource-editor";

export type {
  EditorDraftEffectiveMode,
  EditorFeatures,
  EditorModel,
  EditorResourceSummary,
  EditorUnsetMode,
  LayeredEditorModel,
  LayerInfo,
  ResourceEditorClient,
  ResourceEditorSaveResult,
  ResourceEditorValidateResult,
  SchemaMeta,
  SingleEditorModel,
  UiNode
} from "@workbench-kit/vue-resource-editor";

export const editorApi: ResourceEditorClient = {
  list(): Promise<{ resources: EditorResourceSummary[] }> {
    return api.get("/api/editors");
  },
  load(key: string): Promise<{ editor: EditorModel }> {
    return api.get(`/api/editors/${encodeURIComponent(key)}`);
  },
  validate(key: string, value: unknown): Promise<ResourceEditorValidateResult> {
    return api.post(`/api/editors/${encodeURIComponent(key)}/validate`, { value });
  },
  save(key: string, value: unknown): Promise<ResourceEditorSaveResult> {
    return api.post(`/api/editors/${encodeURIComponent(key)}/save`, { value });
  },
  options(key: string): Promise<{ options: string[] }> {
    return api.get(`/api/editor-options/${encodeURIComponent(key)}`);
  }
};
