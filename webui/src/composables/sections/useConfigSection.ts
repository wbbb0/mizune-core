import {
  createResourceEditorState,
  type EditorRecordMutationEvent,
  type ResourceEditorState,
  type WorkbenchWindowResult
} from "@workbench-kit/vue";
import { computed, ref, watch, type ComputedRef, type Ref } from "vue";
import { useWorkbenchToasts, useWorkbenchWindows } from "@workbench-kit/vue";
import LlmModelAddWindow from "@/sections/config/LlmModelAddWindow.vue";
import { type LlmModelAddEntry } from "@/api/editor";
import {
  editorApi,
  clearEditorMutations,
  getLlmProviderMutationImpact,
  normalizeEditorResource,
  recordEditorMutation,
  resolveEditorMutationSource,
  type EditorModel,
  type EditorResourceSummary,
  type LayeredEditorModel,
  type SingleEditorModel
} from "@/api/editor";
import { createSharedSectionState } from "@/composables/sections/sharedSectionState";

export type ConfigSectionState = ResourceEditorState & {
  standardizing: Ref<boolean>;
  isGlobalConfigSelected: ComputedRef<boolean>;
  canUseDefaultValue: ComputedRef<boolean>;
  canStandardize: ComputedRef<boolean>;
  useDefaultValue: () => void;
  standardize: () => Promise<void>;
  beforeRecordMutation: (event: EditorRecordMutationEvent) => Promise<boolean>;
};

function cloneValue<T>(value: T): T {
  return typeof globalThis.structuredClone === "function"
    ? globalThis.structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as T;
}

export const useConfigSection = createSharedSectionState<ConfigSectionState>(() => {
  const toast = useWorkbenchToasts();
  const windows = useWorkbenchWindows();

  const state = createResourceEditorState({
    client: editorApi,
    domain: "config",
    editableOnly: true,
    notify: (notification) => toast.push(notification),
    saveSuccessMessage: (path) => `已保存 → ${path}`
  });

  const standardizing = ref(false);
  const isGlobalConfigSelected = computed(() => state.selectedKey.value === "global_config" && state.model.value?.kind === "single");
  const isBusy = computed(() => state.loading.value || state.saving.value || state.validating.value || standardizing.value);
  const canUseDefaultValue = computed(() => isGlobalConfigSelected.value && !isBusy.value && !!state.model.value);
  const canStandardize = computed(() => isGlobalConfigSelected.value && !isBusy.value && !!state.model.value);

  watch(state.selectedKey, (_nextKey, previousKey) => {
    if (previousKey) {
      clearEditorMutations(previousKey);
    }
  });

  function useDefaultValue() {
    if (!canUseDefaultValue.value || !state.model.value) {
      return;
    }
    state.updateDraft(cloneValue(state.model.value.schemaDefaultValue));
  }

  async function standardize() {
    if (!canStandardize.value || !state.selectedKey.value || !state.model.value) {
      return;
    }
    const confirmed = await confirmStandardizeGlobalConfig();
    if (!confirmed || !canStandardize.value || !state.selectedKey.value || !state.model.value) {
      return;
    }
    standardizing.value = true;
    try {
      const res = await normalizeEditorResource(state.selectedKey.value, state.draftValue.value);
      toast.push({ type: "success", message: `已标准化 → ${res.path}` });
      await state.reloadFromServer();
    } catch (error: unknown) {
      toast.push({ type: "error", message: error instanceof Error ? error.message : "标准化失败" });
    } finally {
      standardizing.value = false;
    }
  }

  async function reloadFromServer() {
    if (state.selectedKey.value) {
      clearEditorMutations(state.selectedKey.value);
    }
    await state.reloadFromServer();
  }

  async function beforeRecordMutation(event: EditorRecordMutationEvent): Promise<boolean> {
    if (state.selectedKey.value !== "llm_catalog") {
      return true;
    }
    if (event.kind === "add") {
      return addLlmCatalogModel(event.path);
    }
    if (event.path.length !== 0) {
      return true;
    }

    const persistedProvider = resolveEditorMutationSource("llm_catalog", event.key) ?? event.key;
    let impact;
    try {
      impact = await getLlmProviderMutationImpact(persistedProvider);
    } catch (error: unknown) {
      toast.push({ type: "error", message: error instanceof Error ? error.message : "无法分析 Provider 引用" });
      return false;
    }
    if (!impact.exists) {
      return true;
    }

    const referenceSummary = impact.referenceCount > 0
      ? `另有 ${impact.referenceCount} 条路由引用会${event.kind === "rename" ? "同步改名" : "一并移除"}。`
      : "当前没有路由引用。";
    const emptyRoleSummary = event.kind === "remove" && impact.emptiedRoles.length > 0
      ? `删除后将有 ${impact.emptiedRoles.length} 个路由角色变为空清单。`
      : "";
    const result = await windows.openDialog({
      title: event.kind === "rename" ? "重命名 LLM Provider" : "删除 LLM Provider",
      description: event.kind === "rename" ? `${event.key} → ${event.nextKey}` : event.key,
      size: "sm",
      modal: true,
      blocks: [{
        kind: "text",
        content: `该 Provider 下有 ${impact.modelCount} 个模型。${referenceSummary}${emptyRoleSummary}`
      }],
      actions: [{
        id: "confirm",
        label: event.kind === "rename" ? "重命名并更新引用" : "删除模型并移除引用",
        variant: event.kind === "remove" ? "danger" : "primary",
        run: async () => ({ confirmed: true })
      }]
    });
    const confirmed = result.reason === "action" && result.actionId === "confirm";
    if (!confirmed) {
      return false;
    }

    recordEditorMutation("llm_catalog", event.kind === "rename"
      ? { kind: "rename_provider", provider: event.key, nextProvider: event.nextKey }
      : { kind: "delete_provider", provider: event.key });
    return true;
  }

  /** 拦截 llm_catalog 的 provider.models 记录新增：弹窗选择/手写上游模型并自动生成别名。 */
  async function addLlmCatalogModel(path: Array<string | number>): Promise<boolean> {
    if (path.length !== 2 || path[1] !== "models" || typeof path[0] !== "string") {
      return true;
    }
    const providerName = path[0];
    const draft = state.draftValue.value;
    if (!draft || typeof draft !== "object") {
      return true;
    }
    const record = draft as Record<string, unknown>;
    const provider = record[providerName];
    if (!provider || typeof provider !== "object") {
      return true;
    }
    const providerRecord = provider as Record<string, unknown>;
    const existingModels = (providerRecord.models as Record<string, unknown> | undefined) ?? {};

    const result = await windows.open({
      kind: "dialog",
      title: `添加模型 · ${providerName}`,
      description: "从供应商模型清单中选择，或手动填写上游模型名；生成 [a-z0-9_] 别名后写入目录。",
      size: "lg",
      modal: true,
      closeOnBackdrop: false,
      closeOnEscape: false,
      footer: "hidden",
      blocks: [{
        kind: "component",
        component: LlmModelAddWindow,
        props: {
          provider: providerRecord,
          existingAliases: Object.keys(existingModels),
          closeWindow: (windowId: string, closeResult: WorkbenchWindowResult) => windows.close(windowId, closeResult)
        }
      }]
    });

    if (result.reason !== "action" || result.actionId !== "add") {
      return false;
    }
    const entry = result.result as LlmModelAddEntry | undefined;
    if (!entry || !entry.upstreamModel.trim() || !/^[a-z0-9_]+$/.test(entry.alias)) {
      return false;
    }

    const nextDraft = cloneValue(draft);
    const nextRecord = nextDraft as Record<string, unknown>;
    const nextProvider = nextRecord[providerName] as Record<string, unknown>;
    const nextModels = (nextProvider.models as Record<string, unknown> | undefined) ?? {};
    const existing = nextModels[entry.alias] as Record<string, unknown> | undefined;
    nextModels[entry.alias] = {
      upstreamModel: entry.upstreamModel.trim(),
      ...entry.capabilities,
      ...(existing?.apiParameters !== undefined ? { apiParameters: existing.apiParameters } : {})
    };
    nextProvider.models = nextModels;
    state.updateDraft(nextDraft);
    return false;
  }

  async function confirmStandardizeGlobalConfig(): Promise<boolean> {
    const result = await windows.openDialog({
      title: "标准化全局配置",
      description: "确认写回 config/global.yml。",
      size: "sm",
      modal: true,
      blocks: [
        {
          kind: "text",
          content: "标准化会用 schema 默认值填充缺失项、移除未知项，并以规范 YAML 重写原文件。文件中的注释和手写排版会被替换。"
        }
      ],
      actions: [
        {
          id: "standardize",
          label: "标准化并写回",
          variant: "primary",
          run: async () => ({ confirmed: true })
        }
      ]
    });
    return result.reason === "action" && result.actionId === "standardize";
  }

  return {
    ...state,
    standardizing,
    isGlobalConfigSelected,
    canUseDefaultValue,
    canStandardize,
    useDefaultValue,
    standardize,
    reloadFromServer,
    beforeRecordMutation
  };
});

export type { EditorResourceSummary, EditorModel, LayeredEditorModel, SingleEditorModel };
