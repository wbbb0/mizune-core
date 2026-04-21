import { computed, ref, watch, type ComputedRef, type Ref } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import { useLayeredEditorState } from "@/composables/useLayeredEditorState";
import { useWorkbenchRuntime } from "@/composables/workbench/useWorkbenchRuntime";
import { editorApi, type EditorModel, type EditorResourceSummary, type LayeredEditorModel, type SingleEditorModel } from "@/api/editor";
import { useToastStore } from "@/stores/toasts";

type ConfigSectionState = {
  resources: Ref<EditorResourceSummary[]>;
  selectedKey: Ref<string | null>;
  model: Ref<EditorModel | null>;
  loading: Ref<boolean>;
  saving: Ref<boolean>;
  validating: Ref<boolean>;
  draftValue: Ref<unknown>;
  isLayered: ComputedRef<boolean>;
  baseValue: ComputedRef<unknown>;
  storedDraftValue: ComputedRef<unknown>;
  effectiveValue: ComputedRef<unknown>;
  isDirty: ComputedRef<boolean>;
  canSave: ComputedRef<boolean>;
  canValidate: ComputedRef<boolean>;
  resetState: () => void;
  refreshResources: () => Promise<void>;
  selectResource: (key: string) => void;
  updateDraft: (value: unknown) => void;
  validate: () => Promise<void>;
  save: () => Promise<void>;
  reloadFromServer: () => Promise<void>;
};

let sharedState: ConfigSectionState | null = null;

export function useConfigSection() {
  if (!sharedState) {
    const resources = ref<EditorResourceSummary[]>([]);
    const selectedKey = ref<string | null>(null);
    const model = ref<EditorModel | null>(null);
    const loading = ref(false);
    const saving = ref(false);
    const validating = ref(false);
    const toast = useToastStore();
    const workbenchRuntime = useWorkbenchRuntime();
    const layeredState = useLayeredEditorState(model);
    let stateVersion = 0;

    const canSave = computed(() => layeredState.isDirty.value && !validating.value && !saving.value);
    const canValidate = computed(() => !!model.value && !validating.value && !saving.value);

    function isStale(requestVersion: number) {
      return requestVersion !== stateVersion;
    }

    function resetState() {
      stateVersion += 1;
      resources.value = [];
      selectedKey.value = null;
      model.value = null;
      loading.value = false;
      saving.value = false;
      validating.value = false;
      layeredState.resetDraft(null);
    }

    async function refreshResources() {
      const requestVersion = stateVersion;
      const res = await editorApi.list();
      if (isStale(requestVersion)) {
        return;
      }
      resources.value = res.resources.filter((resource) => resource.domain === "config" && resource.editable);
    }

    async function loadSelectedModel(key: string | null) {
      if (!key) {
        model.value = null;
        return;
      }

      const requestVersion = stateVersion;
      const requestKey = key;
      loading.value = true;
      try {
        const res = await editorApi.load(key);
        if (isStale(requestVersion) || selectedKey.value !== requestKey) {
          return;
        }
        model.value = res.editor;
      } finally {
        if (!isStale(requestVersion) && selectedKey.value === requestKey) {
          loading.value = false;
        }
      }
    }

    watch(selectedKey, (key) => {
      void loadSelectedModel(key);
    }, { immediate: true });

    function selectResource(key: string) {
      selectedKey.value = key;
      workbenchRuntime.showMain();
    }

    function updateDraft(value: unknown) {
      layeredState.draftValue.value = value;
    }

    async function validate() {
      const requestVersion = stateVersion;
      if (!selectedKey.value || !model.value || !canValidate.value) {
        return;
      }
      validating.value = true;
      try {
        await editorApi.validate(selectedKey.value, layeredState.draftValue.value);
        if (isStale(requestVersion)) {
          return;
        }
        toast.push({ type: "success", message: "验证通过" });
      } catch (error: unknown) {
        if (isStale(requestVersion)) {
          return;
        }
        toast.push({ type: "error", message: error instanceof Error ? error.message : "验证失败" });
      } finally {
        if (!isStale(requestVersion)) {
          validating.value = false;
        }
      }
    }

    async function save() {
      const requestVersion = stateVersion;
      if (!selectedKey.value || !model.value || !canSave.value) {
        return;
      }
      saving.value = true;
      try {
        const res = await editorApi.save(selectedKey.value, layeredState.draftValue.value);
        if (isStale(requestVersion)) {
          return;
        }
        toast.push({ type: "success", message: `已保存 → ${res.path}` });
        const reloaded = await editorApi.load(selectedKey.value);
        if (isStale(requestVersion)) {
          return;
        }
        model.value = reloaded.editor;
      } catch (error: unknown) {
        if (isStale(requestVersion)) {
          return;
        }
        toast.push({ type: "error", message: error instanceof Error ? error.message : "保存失败" });
      } finally {
        if (!isStale(requestVersion)) {
          saving.value = false;
        }
      }
    }

    async function reloadFromServer() {
      const requestVersion = stateVersion;
      if (!selectedKey.value || !model.value || loading.value || saving.value || validating.value) {
        return;
      }
      loading.value = true;
      try {
        const res = await editorApi.load(selectedKey.value);
        if (isStale(requestVersion)) {
          return;
        }
        model.value = res.editor;
      } finally {
        if (!isStale(requestVersion)) {
          loading.value = false;
        }
      }
    }

    sharedState = {
      resources,
      selectedKey,
      model,
      loading,
      saving,
      validating,
      draftValue: layeredState.draftValue,
      isLayered: layeredState.isLayered,
      baseValue: layeredState.baseValue,
      storedDraftValue: layeredState.storedDraftValue,
      effectiveValue: layeredState.effectiveValue,
      isDirty: layeredState.isDirty,
      canSave,
      canValidate,
      resetState,
      refreshResources,
      selectResource,
      updateDraft,
      validate,
      save,
      reloadFromServer
    };
  }

  onBeforeRouteLeave(() => {
    sharedState?.resetState();
  });

  return sharedState;
}

export type { EditorResourceSummary, EditorModel, LayeredEditorModel, SingleEditorModel };
