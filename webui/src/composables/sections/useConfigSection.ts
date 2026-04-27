import { computed, ref, watch, type ComputedRef, type Ref } from "vue";
import { useEditorDraftState } from "@/composables/useEditorDraftState";
import { useWorkbenchNavigation } from "@/components/workbench/runtime/workbenchRuntime";
import { createSharedSectionState } from "@/composables/sections/sharedSectionState";
import { editorApi, type EditorModel, type EditorResourceSummary, type LayeredEditorModel, type SingleEditorModel } from "@/api/editor";
import { useWorkbenchToasts } from "@/components/workbench/toasts/useWorkbenchToasts";

type ConfigSectionState = {
  resources: Ref<EditorResourceSummary[]>;
  selectedKey: Ref<string | null>;
  model: Ref<EditorModel | null>;
  loading: Ref<boolean>;
  saving: Ref<boolean>;
  validating: Ref<boolean>;
  draftValue: Ref<unknown>;
  referenceValue: ComputedRef<unknown>;
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

export const useConfigSection = createSharedSectionState<ConfigSectionState>(() => {
    const resources = ref<EditorResourceSummary[]>([]);
    const selectedKey = ref<string | null>(null);
    const model = ref<EditorModel | null>(null);
    const loading = ref(false);
    const saving = ref(false);
    const validating = ref(false);
    const toast = useWorkbenchToasts();
    const workbenchNavigation = useWorkbenchNavigation();
    const editorState = useEditorDraftState(model);
    let stateVersion = 0;

    const canSave = computed(() => editorState.isDirty.value && !validating.value && !saving.value);
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
      editorState.resetDraft(null);
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
      workbenchNavigation.showMain();
    }

    function updateDraft(value: unknown) {
      editorState.draftValue.value = value;
    }

    async function validate() {
      const requestVersion = stateVersion;
      if (!selectedKey.value || !model.value || !canValidate.value) {
        return;
      }
      validating.value = true;
      try {
        await editorApi.validate(selectedKey.value, editorState.draftValue.value);
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
        const res = await editorApi.save(selectedKey.value, editorState.draftValue.value);
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

    return {
      resources,
      selectedKey,
      model,
      loading,
      saving,
      validating,
      draftValue: editorState.draftValue,
      referenceValue: editorState.referenceValue,
      storedDraftValue: editorState.storedDraftValue,
      effectiveValue: editorState.effectiveValue,
      isDirty: editorState.isDirty,
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
});

export type { EditorResourceSummary, EditorModel, LayeredEditorModel, SingleEditorModel };
