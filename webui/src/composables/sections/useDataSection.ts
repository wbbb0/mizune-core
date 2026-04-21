import { computed, ref, watch, type ComputedRef, type Ref } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import { useLayeredEditorState } from "@/composables/useLayeredEditorState";
import { useWorkbenchRuntime } from "@/composables/workbench/useWorkbenchRuntime";
import { dataApi, type DataResourceSummary, type DataResource, type DataResourceItem, type DirectoryItem } from "@/api/data";
import { editorApi, type EditorModel, type EditorResourceSummary } from "@/api/editor";
import { useToastStore } from "@/stores/toasts";

type DataListResource =
  | {
      key: string;
      title: string;
      source: "browser";
      kind: DataResourceSummary["kind"];
      editable: false;
    }
  | {
      key: string;
      title: string;
      source: "editor";
      kind: EditorResourceSummary["kind"];
      editable: boolean;
    };

type DataSectionState = {
  resources: Ref<DataListResource[]>;
  selectedKey: Ref<string | null>;
  selectedItemKey: Ref<string | null>;
  selectedResource: ComputedRef<DataListResource | null>;
  resource: Ref<DataResource | null>;
  model: Ref<EditorModel | null>;
  itemDetail: Ref<DataResourceItem | null>;
  loading: Ref<boolean>;
  loadingItem: Ref<boolean>;
  saving: Ref<boolean>;
  validating: Ref<boolean>;
  draftValue: Ref<unknown>;
  isLayered: ComputedRef<boolean>;
  baseValue: ComputedRef<unknown>;
  storedDraftValue: ComputedRef<unknown>;
  effectiveValue: ComputedRef<unknown>;
  isDirty: ComputedRef<boolean>;
  canSubmit: ComputedRef<boolean>;
  formattedJson: ComputedRef<string>;
  formattedItemJson: ComputedRef<string>;
  mobileHeaderTitle: ComputedRef<string>;
  resetState: () => void;
  refreshResources: () => Promise<void>;
  selectResource: (key: string) => void;
  selectDirectoryItem: (key: string) => void;
  refreshSelected: () => Promise<void>;
  reloadFromServer: () => Promise<void>;
  validate: () => Promise<void>;
  save: () => Promise<void>;
  updateDraft: (value: unknown) => void;
  formatSize: (bytes: number) => string;
  formatTime: (ms: number) => string;
  resourceBadge: (resourceEntry: DataListResource) => string;
};

let sharedState: DataSectionState | null = null;

export function useDataSection() {
  if (!sharedState) {
    const resources = ref<DataListResource[]>([]);
    const selectedKey = ref<string | null>(null);
    const selectedItemKey = ref<string | null>(null);
    const resource = ref<DataResource | null>(null);
    const model = ref<EditorModel | null>(null);
    const itemDetail = ref<DataResourceItem | null>(null);
    const loading = ref(false);
    const loadingItem = ref(false);
    const saving = ref(false);
    const validating = ref(false);
    const toast = useToastStore();
    const workbenchRuntime = useWorkbenchRuntime();
    const layeredState = useLayeredEditorState(model);
    let stateVersion = 0;

    const selectedResource = computed(() =>
      resources.value.find((entry) => entry.key === selectedKey.value) ?? null
    );
    const canSubmit = computed(() => !!selectedResource.value?.editable && layeredState.isDirty.value && !validating.value && !saving.value);

    const formattedJson = computed(() => {
      if (!resource.value || resource.value.kind !== "single_json") return "";
      return JSON.stringify(resource.value.value, null, 2);
    });

    const formattedItemJson = computed(() =>
      itemDetail.value ? JSON.stringify(itemDetail.value.value, null, 2) : ""
    );

    const mobileHeaderTitle = computed(() => {
      if (selectedResource.value?.source === "editor" && model.value) {
        return model.value.title;
      }
      if (selectedResource.value?.source === "browser" && resource.value) {
        if (resource.value.kind === "directory_json" && itemDetail.value) {
          return itemDetail.value.title || itemDetail.value.key;
        }
        return resource.value.title;
      }
      return "";
    });

    function isStale(requestVersion: number) {
      return requestVersion !== stateVersion;
    }

    function resetState() {
      stateVersion += 1;
      resources.value = [];
      selectedKey.value = null;
      selectedItemKey.value = null;
      resource.value = null;
      model.value = null;
      itemDetail.value = null;
      loading.value = false;
      loadingItem.value = false;
      saving.value = false;
      validating.value = false;
      layeredState.resetDraft(null);
    }

    async function refreshResources() {
      const requestVersion = stateVersion;
      const [dataRes, editorRes] = await Promise.all([dataApi.list(), editorApi.list()]);
      if (isStale(requestVersion)) {
        return;
      }
      resources.value = [
        ...editorRes.resources
          .filter((entry) => entry.domain === "data")
          .map((entry) => ({
            key: entry.key,
            title: entry.title,
            source: "editor" as const,
            kind: entry.kind,
            editable: entry.editable
          })),
        ...dataRes.resources.map((entry) => ({
          key: entry.key,
          title: entry.title,
          source: "browser" as const,
          kind: entry.kind,
          editable: false as const
        }))
      ].sort((left, right) => left.key.localeCompare(right.key));
    }

    watch(selectedKey, async (key) => {
      const requestVersion = stateVersion;
      const requestKey = key;
      resource.value = null;
      model.value = null;
      itemDetail.value = null;
      selectedItemKey.value = null;
      if (!key) return;

      const target = resources.value.find((entry) => entry.key === key);
      if (!target) return;

      loading.value = true;
      try {
        if (target.source === "browser") {
          const res = await dataApi.get(key);
          if (isStale(requestVersion) || selectedKey.value !== requestKey) {
            return;
          }
          resource.value = res.resource;
          return;
        }

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
    });

    watch(selectedItemKey, async (itemKey) => {
      const requestVersion = stateVersion;
      const requestItemKey = itemKey;
      itemDetail.value = null;
      if (!itemKey || !selectedKey.value || selectedResource.value?.source !== "browser") return;
      loadingItem.value = true;
      try {
        const res = await dataApi.getItem(selectedKey.value, itemKey);
        if (isStale(requestVersion) || selectedItemKey.value !== requestItemKey) {
          return;
        }
        itemDetail.value = res.item;
      } finally {
        if (!isStale(requestVersion) && selectedItemKey.value === requestItemKey) {
          loadingItem.value = false;
        }
      }
    });

    function selectResource(key: string) {
      selectedKey.value = key;
      workbenchRuntime.showMain();
    }

    function selectDirectoryItem(key: string) {
      selectedItemKey.value = key;
      workbenchRuntime.showMain();
    }

    async function refreshSelected() {
      const requestVersion = stateVersion;
      if (!selectedKey.value || !selectedResource.value) return;
      loading.value = true;
      try {
        if (selectedResource.value.source === "browser") {
          const res = await dataApi.get(selectedKey.value);
          if (isStale(requestVersion)) {
            return;
          }
          resource.value = res.resource;
          return;
        }

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

    async function reloadFromServer() {
      const requestVersion = stateVersion;
      if (!selectedKey.value || !model.value || loading.value || saving.value || validating.value) return;
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

    async function validate() {
      const requestVersion = stateVersion;
      if (!selectedKey.value || !model.value || !canSubmit.value) return;
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
      if (!selectedKey.value || !model.value || !canSubmit.value) return;
      saving.value = true;
      try {
        const res = await editorApi.save(selectedKey.value, layeredState.draftValue.value);
        if (isStale(requestVersion)) {
          return;
        }
        toast.push({ type: "success", message: `已保存 → ${res.path}` });
        await refreshSelected();
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

    function updateDraft(value: unknown) {
      layeredState.draftValue.value = value;
    }

    function formatSize(bytes: number): string {
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    function formatTime(ms: number): string {
      return new Date(ms).toLocaleString("zh-CN");
    }

    function resourceBadge(resourceEntry: DataListResource): string {
      if (resourceEntry.source === "editor") {
        if (!resourceEntry.editable) return "只读";
        return resourceEntry.kind === "layered" ? "编辑器" : "JSON";
      }
      return resourceEntry.kind === "directory_json" ? "目录" : "JSON";
    }

    sharedState = {
      resources,
      selectedKey,
      selectedItemKey,
      selectedResource,
      resource,
      model,
      itemDetail,
      loading,
      loadingItem,
      saving,
      validating,
      draftValue: layeredState.draftValue,
      isLayered: layeredState.isLayered,
      baseValue: layeredState.baseValue,
      storedDraftValue: layeredState.storedDraftValue,
      effectiveValue: layeredState.effectiveValue,
      isDirty: layeredState.isDirty,
      canSubmit,
      formattedJson,
      formattedItemJson,
      mobileHeaderTitle,
      resetState,
      refreshResources,
      selectResource,
      selectDirectoryItem,
      refreshSelected,
      reloadFromServer,
      validate,
      save,
      updateDraft,
      formatSize,
      formatTime,
      resourceBadge
    };
  }

  onBeforeRouteLeave(() => {
    sharedState?.resetState();
  });

  return sharedState;
}

export type { DataResourceSummary, DataResource, DataResourceItem, DirectoryItem, EditorModel, EditorResourceSummary };
