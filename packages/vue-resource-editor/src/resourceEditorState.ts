import { computed, ref, watch, type ComputedRef, type Ref } from "vue";
import { useEditorDraftState } from "./useEditorDraftState";
import type { EditorModel, EditorResourceSummary, ResourceEditorClient } from "./types";

export type ResourceEditorNotification = {
  type: "success" | "error";
  message: string;
};

/** createResourceEditorState 的接线选项。 */
export type ResourceEditorStateOptions = {
  /** 业务项目实现的资源编辑 client。 */
  client: ResourceEditorClient;
  /** 可选资源域过滤。 */
  domain?: EditorResourceSummary["domain"];
  /** true 时只保留 editable 资源。 */
  editableOnly?: boolean;
  /** 选中资源后回调，通常用于移动端跳转 mainArea。 */
  onSelect?: () => void;
  /** 校验/保存成功失败通知回调。 */
  notify?: (notification: ResourceEditorNotification) => void;
  /** 自定义保存成功消息。 */
  saveSuccessMessage?: (path: string) => string;
};

/** 资源编辑页面可直接消费的一组响应式状态和动作。 */
export type ResourceEditorState = {
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

/** 创建通用资源编辑状态，封装 list/load/validate/save/reload 和草稿管理。 */
export function createResourceEditorState(options: ResourceEditorStateOptions): ResourceEditorState {
  const resources = ref<EditorResourceSummary[]>([]);
  const selectedKey = ref<string | null>(null);
  const model = ref<EditorModel | null>(null);
  const loading = ref(false);
  const saving = ref(false);
  const validating = ref(false);
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
    const res = await options.client.list();
    if (isStale(requestVersion)) {
      return;
    }
    resources.value = res.resources.filter((resource) => (
      (options.domain === undefined || resource.domain === options.domain)
      && (!options.editableOnly || resource.editable)
    ));
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
      const res = await options.client.load(key);
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
    options.onSelect?.();
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
      await options.client.validate(selectedKey.value, editorState.draftValue.value);
      if (isStale(requestVersion)) {
        return;
      }
      options.notify?.({ type: "success", message: "验证通过" });
    } catch (error: unknown) {
      if (isStale(requestVersion)) {
        return;
      }
      options.notify?.({ type: "error", message: error instanceof Error ? error.message : "验证失败" });
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
      const res = await options.client.save(selectedKey.value, editorState.draftValue.value);
      if (isStale(requestVersion)) {
        return;
      }
      options.notify?.({
        type: "success",
        message: options.saveSuccessMessage?.(res.path) ?? `已保存 -> ${res.path}`
      });
      const reloaded = await options.client.load(selectedKey.value);
      if (isStale(requestVersion)) {
        return;
      }
      model.value = reloaded.editor;
    } catch (error: unknown) {
      if (isStale(requestVersion)) {
        return;
      }
      options.notify?.({ type: "error", message: error instanceof Error ? error.message : "保存失败" });
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
      const res = await options.client.load(selectedKey.value);
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
}
