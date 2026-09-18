import { api } from "./client";
import type {
  EditorModel,
  EditorOptionsResult,
  EditorResourceSummary,
  ResourceEditorClient,
  ResourceEditorSaveResult,
  ResourceEditorValidateResult
} from "@workbench-kit/vue";
import {
  mergeProviderMutation,
  reconcileProviderMutations,
  resolveProviderMutationSource,
  type LlmCatalogProviderMutation
} from "./editorMutationQueue";

export type { LlmCatalogProviderMutation } from "./editorMutationQueue";

export interface LlmProviderMutationImpact {
  provider: string;
  exists: boolean;
  modelCount: number;
  referenceCount: number;
  references: Array<{ preset: string; role: string; indexes: number[] }>;
  emptiedRoles: Array<{ preset: string; role: string }>;
}

const pendingMutations = new Map<string, LlmCatalogProviderMutation[]>();
const editorBaselines = new Map<string, unknown>();
const editorRevisions = new Map<string, string>();

export function recordEditorMutation(key: string, mutation: LlmCatalogProviderMutation): void {
  const current = pendingMutations.get(key) ?? [];
  const next = mergeProviderMutation(current, mutation);
  if (next.length === 0) {
    pendingMutations.delete(key);
    return;
  }
  pendingMutations.set(key, next);
}

export function resolveEditorMutationSource(key: string, provider: string): string | null {
  return resolveProviderMutationSource(pendingMutations.get(key) ?? [], provider);
}

export function clearEditorMutations(key?: string): void {
  if (key) {
    pendingMutations.delete(key);
    return;
  }
  pendingMutations.clear();
}

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
} from "@workbench-kit/vue";

export const editorApi: ResourceEditorClient = {
  list(): Promise<{ resources: EditorResourceSummary[] }> {
    return api.get("/api/editors");
  },
  load(key: string): Promise<{ editor: EditorModel }> {
    return api.get<{ editor: EditorModel & { revision?: string } }>(`/api/editors/${encodeURIComponent(key)}`).then((result) => {
      if (key === "llm_catalog") {
        editorBaselines.set(key, cloneEditorValue(result.editor.currentValue));
      }
      if (typeof result.editor.revision === "string") {
        editorRevisions.set(key, result.editor.revision);
      } else {
        editorRevisions.delete(key);
      }
      return result;
    });
  },
  validate(key: string, value: unknown): Promise<ResourceEditorValidateResult> {
    return api.post(`/api/editors/${encodeURIComponent(key)}/validate`, { value });
  },
  async save(key: string, value: unknown): Promise<ResourceEditorSaveResult> {
    const mutations = reconcileProviderMutations(
      pendingMutations.get(key) ?? [],
      value,
      editorBaselines.get(key)
    );
    if (mutations.length > 0) {
      pendingMutations.set(key, mutations);
    } else {
      pendingMutations.delete(key);
    }
    const result = await api.post<ResourceEditorSaveResult>(`/api/editors/${encodeURIComponent(key)}/save`, {
      value,
      mutations,
      revision: editorRevisions.get(key)
    });
    pendingMutations.delete(key);
    return result;
  },
  options(key: string): Promise<EditorOptionsResult> {
    return api.get(`/api/editor-options/${encodeURIComponent(key)}`);
  }
};

function cloneEditorValue<T>(value: T): T {
  return typeof globalThis.structuredClone === "function"
    ? globalThis.structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as T;
}

export function getLlmProviderMutationImpact(provider: string): Promise<LlmProviderMutationImpact> {
  return api.post("/api/editors/llm_catalog/provider-impact", { provider });
}

export function normalizeEditorResource(
  key: string,
  value: unknown
): Promise<ResourceEditorSaveResult> {
  return api.post(`/api/editors/${encodeURIComponent(key)}/normalize`, { value });
}

/** 从模型清单接口拉取得到的可导入模型行。 */
export interface ProviderModelSlot {
  upstreamModel: string;
  alias: string;
  exists: boolean;
  capabilities: Record<string, string | boolean>;
}

export type ProviderModelListResult =
  | { kind: "ok"; providerType: string; endpoint: string | null; models: ProviderModelSlot[] }
  | { kind: "unsupported"; providerType: string; reason: string };

/** 新增模型弹窗提交的条目，写入 provider.models[alias]。 */
export interface LlmModelAddEntry {
  upstreamModel: string;
  alias: string;
  capabilities: Record<string, string | boolean>;
}

/** 按供应商草稿的连接信息拉取其模型清单并生成为可导入槽位。 */
export function listProviderModels(provider: unknown): Promise<ProviderModelListResult> {
  return api.post(`/api/editors/llm_catalog/list-models`, { provider: pruneEmptyOptionalFields(provider) });
}

/** 剔除草稿中清空为 "" 的可选连接字段，避免服务端 nonempty 校验误判为非法输入。 */
function pruneEmptyOptionalFields(provider: unknown): unknown {
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
    return provider;
  }
  const record = provider as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === "") {
      continue;
    }
    next[key] = value;
  }
  return next;
}
