import { createResourceEditorState, type ResourceEditorState } from "@workbench-kit/vue";
import { computed, ref, type ComputedRef, type Ref } from "vue";
import { useWorkbenchToasts, useWorkbenchWindows } from "@workbench-kit/vue";
import {
  editorApi,
  normalizeEditorResource,
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
    standardize
  };
});

export type { EditorResourceSummary, EditorModel, LayeredEditorModel, SingleEditorModel };
