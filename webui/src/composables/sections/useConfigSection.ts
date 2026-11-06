import {
  createResourceEditorState,
  type EditorRecordMutationEvent,
  type EditorNodeActions,
  type ResourceEditorState
} from "@workbench-kit/vue";
import { computed, ref, watch, type ComputedRef, type Ref } from "vue";
import { useWorkbenchToasts, useWorkbenchWindows } from "@workbench-kit/vue";
import { createModelTestNodeActions } from "@/sections/config/modelTestActions";
import LlmModelTestWindow from "@/sections/config/LlmModelTestWindow.vue";
import { resolveModelAddSchema } from "@/sections/config/modelAddSchema";
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
  nodeActions: EditorNodeActions;
  beforeRecordMutation: (event: EditorRecordMutationEvent) => Promise<boolean>;
};

function cloneValue<T>(value: T): T {
  // 编辑器配置是 JSON 数据；序列化同时解除所有嵌套 Vue Proxy。
  return JSON.parse(JSON.stringify(value)) as T;
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

  const nodeActions = createModelTestNodeActions({
    getResourceKey: () => state.selectedKey.value,
    getDraft: () => state.draftValue.value,
    openTest: ({ providerName, modelName, provider, model }) => {
      windows.openSync({
        kind: "dialog", title: `测试模型 · ${providerName}/${modelName}`, size: "lg", modal: true,
        closeLabel: "关闭", blocks: [{ kind: "component", component: LlmModelTestWindow,
          props: { provider, model } }]
      });
    }
  });

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
      ? `另有 ${impact.referenceCount} 条模型引用（含向量配置）会${event.kind === "rename" ? "同步改名" : "一并移除"}。`
      : "当前没有模型引用。";
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
    const providerType = providerRecord.type;
    const sourceModel = state.model.value;
    const modelSchema = resolveModelAddSchema(sourceModel?.uiTree, providerType);
    if (!modelSchema || !sourceModel) {
      toast.push({ type: "error", message: "模型表单尚未加载，请重新读取目录" });
      return false;
    }

    function currentProvider(): Record<string, unknown> {
      if (state.selectedKey.value !== "llm_catalog" || state.model.value !== sourceModel) {
        throw new Error("当前配置目录已切换或重新读取，请重新打开添加窗口");
      }
      const current = (state.draftValue.value as Record<string, unknown>)?.[providerName];
      if (!current || typeof current !== "object" || (current as Record<string, unknown>).type !== providerType) {
        throw new Error("供应商已删除或类型已变化，请重新打开添加窗口");
      }
      return current as Record<string, unknown>;
    }

    async function submitEntry(rawEntry: LlmModelAddEntry): Promise<boolean> {
      const entry = cloneValue(rawEntry);
      entry.upstreamModel = entry.upstreamModel.trim();
      entry.alias = entry.alias.trim();
      if (!entry.upstreamModel || !/^[a-z0-9_]+$/.test(entry.alias)) throw new Error("模型配置尚未完成");
      const provider = currentProvider();
      const models = (provider.models ?? {}) as Record<string, Record<string, unknown>>;
      const updating = models[entry.alias]?.upstreamModel === entry.upstreamModel;
      const baseline = JSON.stringify(state.draftValue.value);
      function assertDraftUnchanged() {
        currentProvider();
        if (JSON.stringify(state.draftValue.value) !== baseline) throw new Error("配置草稿已变化，请检查后重新添加");
      }
      const confirmation = await windows.openDialog({
        title: updating ? "确认更新模型" : "确认添加模型",
        description: `${providerName}/${entry.alias}`,
        size: "sm", modal: true,
        blocks: [{ kind: "text", content: `将模型 ${entry.upstreamModel} ${updating ? "更新到" : "加入"}当前配置草稿。确认后可继续添加其他模型，完成后仍需保存目录。` }],
        actions: [{ id: "confirm", label: updating ? "确认更新" : "确认添加", variant: "primary", run: () => true }]
      });
      if (confirmation.reason !== "action" || confirmation.actionId !== "confirm") return false;
      if (!windows.get(modelWindow.id)) return false;
      assertDraftUnchanged();
      const nextDraft = cloneValue(state.draftValue.value) as Record<string, unknown>;
      const nextProvider = nextDraft[providerName] as Record<string, unknown>;
      const nextModels = (nextProvider.models ?? {}) as Record<string, Record<string, unknown>>;
      const existing = nextModels[entry.alias];
      if (existing && existing.upstreamModel !== entry.upstreamModel) throw new Error(`别名 ${entry.alias} 已被其他模型使用`);
      if (!existing && Object.values(nextModels).some(model => model.upstreamModel === entry.upstreamModel)) {
        throw new Error("该上游模型已有其他别名，请重新选择模型");
      }
      nextModels[entry.alias] = { ...entry.profile, upstreamModel: entry.upstreamModel };
      nextProvider.models = nextModels;
      // 所有表单字段共用目录校验，错误时保留窗口与当前草稿。
      await editorApi.validate("llm_catalog", nextDraft);
      if (!windows.get(modelWindow.id)) return false;
      assertDraftUnchanged();
      state.updateDraft(nextDraft);
      toast.push({ type: "success", message: `${updating ? "已更新" : "已添加"} ${providerName}/${entry.alias} 到草稿` });
      return true;
    }

    const modelWindow = windows.openSync({
      kind: "dialog",
      title: `添加模型 · ${providerName}`,
      description: "从供应商清单选择，或手动填写模型；确认后加入草稿，可连续添加。",
      size: "xl", modal: true, footer: "hidden",
      closeOnBackdrop: false, closeOnEscape: false,
      blocks: [{
        kind: "component", component: LlmModelAddWindow, grow: true,
        props: () => ({
          provider: (state.draftValue.value as Record<string, unknown>)?.[providerName] ?? providerRecord,
          modelSchema,
          editorFeatures: sourceModel.editorFeatures,
          submitEntry,
          closeWindow: () => windows.close(modelWindow.id, { reason: "close", values: {} })
        })
      }]
    });

    const width = window.innerWidth, height = window.innerHeight;
    windows.setMaximized(modelWindow.id, {
      maximized: true,
      bounds: { position: { x: 0, y: 0 }, sizePx: { width, height } },
      restoreBounds: {
        position: { x: 0, y: 0 },
        sizePx: { width: Math.min(960, width), height: Math.min(720, height) }
      }
    });
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
    beforeRecordMutation,
    nodeActions
  };
});

export type { EditorResourceSummary, EditorModel, LayeredEditorModel, SingleEditorModel };
