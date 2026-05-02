import { computed, ref, watch, type ComputedRef, type Ref } from "vue";
import { useEditorDraftState } from "@/composables/useEditorDraftState";
import { useWorkbenchNavigation } from "@/components/workbench/runtime/workbenchRuntime";
import { createSharedSectionState } from "@/composables/sections/sharedSectionState";
import { contextApi, type ContextItemFilters, type ContextManagementItem, type ContextStatus } from "@/api/context";
import { dataApi, type DataResourceSummary, type DataResource, type DataResourceItem, type DirectoryItem } from "@/api/data";
import { editorApi, type EditorModel, type EditorResourceSummary } from "@/api/editor";
import { useWorkbenchToasts } from "@/components/workbench/toasts/useWorkbenchToasts";

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
    }
  | {
      key: "context_items";
      title: string;
      source: "context";
      kind: "context_items";
      editable: true;
    };

type DataSectionState = {
  resources: Ref<DataListResource[]>;
  selectedKey: Ref<string | null>;
  selectedItemKey: Ref<string | null>;
  selectedResource: ComputedRef<DataListResource | null>;
  resource: Ref<DataResource | null>;
  model: Ref<EditorModel | null>;
  itemDetail: Ref<DataResourceItem | null>;
  contextItems: Ref<ContextManagementItem[]>;
  contextTotal: Ref<number>;
  contextFilters: Ref<ContextItemFilters>;
  contextStatus: Ref<ContextStatus | null>;
  deletingContextItemId: Ref<string | null>;
  pinningContextItemId: Ref<string | null>;
  contextMaintenanceBusy: Ref<boolean>;
  loading: Ref<boolean>;
  loadingItem: Ref<boolean>;
  saving: Ref<boolean>;
  validating: Ref<boolean>;
  draftValue: Ref<unknown>;
  referenceValue: ComputedRef<unknown>;
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
  refreshContextItems: () => Promise<void>;
  deleteContextItem: (itemId: string) => Promise<void>;
  editContextItem: (item: ContextManagementItem) => Promise<void>;
  toggleContextItemPinned: (item: ContextManagementItem) => Promise<void>;
  bulkDeleteContextItems: () => Promise<void>;
  exportContextItems: () => Promise<void>;
  importContextItems: () => Promise<void>;
  compactContextUser: () => Promise<void>;
  sweepDeletedContextItems: () => Promise<void>;
  clearContextEmbeddings: () => Promise<void>;
  resetContextIndex: () => Promise<void>;
  rebuildContextIndex: () => Promise<void>;
  updateContextFilter: <K extends keyof ContextItemFilters>(key: K, value: ContextItemFilters[K]) => void;
  reloadFromServer: () => Promise<void>;
  validate: () => Promise<void>;
  save: () => Promise<void>;
  updateDraft: (value: unknown) => void;
  formatSize: (bytes: number) => string;
  formatTime: (ms: number) => string;
  formatContextMeta: (item: ContextManagementItem) => string;
  resourceBadge: (resourceEntry: DataListResource) => string;
};

export const useDataSection = createSharedSectionState<DataSectionState>(() => {
    const resources = ref<DataListResource[]>([]);
    const selectedKey = ref<string | null>(null);
    const selectedItemKey = ref<string | null>(null);
    const resource = ref<DataResource | null>(null);
    const model = ref<EditorModel | null>(null);
    const itemDetail = ref<DataResourceItem | null>(null);
    const contextItems = ref<ContextManagementItem[]>([]);
    const contextTotal = ref(0);
    const contextStatus = ref<ContextStatus | null>(null);
    const contextFilters = ref<ContextItemFilters>({
      status: "active",
      limit: 100
    });
    const deletingContextItemId = ref<string | null>(null);
    const pinningContextItemId = ref<string | null>(null);
    const contextMaintenanceBusy = ref(false);
    const loading = ref(false);
    const loadingItem = ref(false);
    const saving = ref(false);
    const validating = ref(false);
    const toast = useWorkbenchToasts();
    const workbenchNavigation = useWorkbenchNavigation();
    const editorState = useEditorDraftState(model);
    let stateVersion = 0;

    const selectedResource = computed(() =>
      resources.value.find((entry) => entry.key === selectedKey.value) ?? null
    );
    const canSubmit = computed(() => !!selectedResource.value?.editable && editorState.isDirty.value && !validating.value && !saving.value);

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
      if (selectedResource.value?.source === "context") {
        return selectedResource.value.title;
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
      contextItems.value = [];
      contextTotal.value = 0;
      contextStatus.value = null;
      loading.value = false;
      loadingItem.value = false;
      saving.value = false;
      validating.value = false;
      editorState.resetDraft(null);
    }

    async function refreshResources() {
      const requestVersion = stateVersion;
      const [dataRes, editorRes] = await Promise.all([dataApi.list(), editorApi.list()]);
      if (isStale(requestVersion)) {
        return;
      }
      const nextResources: DataListResource[] = [
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
        })),
        {
          key: "context_items",
          title: "上下文记忆",
          source: "context" as const,
          kind: "context_items" as const,
          editable: true as const
        }
      ];
      resources.value = nextResources.sort((left, right) => left.key.localeCompare(right.key));
    }

    watch(selectedKey, async (key) => {
        const requestVersion = stateVersion;
        const requestKey = key;
        resource.value = null;
        model.value = null;
        itemDetail.value = null;
        contextItems.value = [];
        contextTotal.value = 0;
        contextStatus.value = null;
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

          if (target.source === "context") {
            await loadContextView(requestVersion);
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
      workbenchNavigation.showArea("mainArea");
    }

    function selectDirectoryItem(key: string) {
      selectedItemKey.value = key;
      workbenchNavigation.showArea("mainArea");
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

        if (selectedResource.value.source === "context") {
          await loadContextView(requestVersion);
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

    async function refreshContextItems() {
      const requestVersion = stateVersion;
      if (selectedResource.value?.source !== "context") return;
      loading.value = true;
      try {
        await loadContextView(requestVersion);
      } catch (error: unknown) {
        if (isStale(requestVersion)) {
          return;
        }
        toast.push({ type: "error", message: error instanceof Error ? error.message : "读取上下文失败" });
      } finally {
        if (!isStale(requestVersion)) {
          loading.value = false;
        }
      }
    }

    async function loadContextItems(requestVersion: number) {
      const res = await contextApi.listItems({
        ...contextFilters.value,
        userId: contextFilters.value.userId?.trim() || undefined
      });
      if (isStale(requestVersion)) {
        return;
      }
      contextItems.value = res.items;
      contextTotal.value = res.total;
    }

    async function loadContextView(requestVersion: number) {
      const [status] = await Promise.all([
        contextApi.getStatus(),
        loadContextItems(requestVersion)
      ]);
      if (isStale(requestVersion)) {
        return;
      }
      contextStatus.value = status;
    }

    async function deleteContextItem(itemId: string) {
      const requestVersion = stateVersion;
      if (!itemId || deletingContextItemId.value) return;
      if (!window.confirm("删除这条上下文记忆？")) return;
      deletingContextItemId.value = itemId;
      try {
        await contextApi.deleteItem(itemId);
        if (isStale(requestVersion)) {
          return;
        }
        toast.push({ type: "success", message: "已删除上下文记忆" });
        await loadContextItems(requestVersion);
      } catch (error: unknown) {
        if (isStale(requestVersion)) {
          return;
        }
        toast.push({ type: "error", message: error instanceof Error ? error.message : "删除失败" });
      } finally {
        if (!isStale(requestVersion)) {
          deletingContextItemId.value = null;
        }
      }
    }

    async function editContextItem(item: ContextManagementItem) {
      const title = window.prompt("标题", item.title ?? "");
      if (title == null) return;
      const text = window.prompt("内容", item.text);
      if (text == null) return;
      const retrievalPolicy = window.prompt("retrievalPolicy: always / search / never", item.retrievalPolicy);
      if (retrievalPolicy == null) return;
      const status = window.prompt("status: active / archived / deleted / superseded", item.status);
      if (status == null) return;
      const sensitivity = window.prompt("sensitivity: normal / private / secret", item.sensitivity);
      if (sensitivity == null) return;
      const validToText = window.prompt("validTo 时间戳毫秒，留空表示无", item.validTo ? String(item.validTo) : "");
      if (validToText == null) return;
      const supersededBy = window.prompt("supersededBy itemId，留空表示无", item.supersededBy ?? "");
      if (supersededBy == null) return;
      const requestVersion = stateVersion;
      try {
        await contextApi.updateItem(item.itemId, {
          title: title.trim() || null,
          text,
          retrievalPolicy: retrievalPolicy.trim() as ContextManagementItem["retrievalPolicy"],
          status: status.trim() as ContextManagementItem["status"],
          sensitivity: sensitivity.trim() as ContextManagementItem["sensitivity"],
          validTo: validToText.trim() ? Number(validToText.trim()) : null,
          supersededBy: supersededBy.trim() || null
        });
        if (isStale(requestVersion)) return;
        toast.push({ type: "success", message: "已更新上下文记忆" });
        await loadContextItems(requestVersion);
      } catch (error: unknown) {
        if (isStale(requestVersion)) return;
        toast.push({ type: "error", message: error instanceof Error ? error.message : "更新失败" });
      }
    }

    async function toggleContextItemPinned(item: ContextManagementItem) {
      const requestVersion = stateVersion;
      if (!item.itemId || pinningContextItemId.value) return;
      pinningContextItemId.value = item.itemId;
      try {
        await contextApi.setPinned(item.itemId, !item.pinned);
        if (isStale(requestVersion)) {
          return;
        }
        toast.push({ type: "success", message: item.pinned ? "已取消固定" : "已固定上下文记忆" });
        await loadContextItems(requestVersion);
      } catch (error: unknown) {
        if (isStale(requestVersion)) {
          return;
        }
        toast.push({ type: "error", message: error instanceof Error ? error.message : "更新固定状态失败" });
      } finally {
        if (!isStale(requestVersion)) {
          pinningContextItemId.value = null;
        }
      }
    }

    function updateContextFilter<K extends keyof ContextItemFilters>(key: K, value: ContextItemFilters[K]) {
      contextFilters.value = {
        ...contextFilters.value,
        [key]: value
      };
    }

    async function runContextMaintenance<T>(
      action: () => Promise<T>,
      successMessage: (result: T) => string
    ) {
      const requestVersion = stateVersion;
      if (contextMaintenanceBusy.value) return;
      contextMaintenanceBusy.value = true;
      try {
        const result = await action();
        if (isStale(requestVersion)) return;
        toast.push({ type: "success", message: successMessage(result) });
        await loadContextView(requestVersion);
      } catch (error: unknown) {
        if (isStale(requestVersion)) return;
        toast.push({ type: "error", message: error instanceof Error ? error.message : "维护操作失败" });
      } finally {
        if (!isStale(requestVersion)) {
          contextMaintenanceBusy.value = false;
        }
      }
    }

    async function bulkDeleteContextItems() {
      if (!window.confirm("按当前过滤条件批量删除上下文记忆？")) return;
      await runContextMaintenance(
        () => contextApi.bulkDelete(contextFilters.value),
        (result) => `已删除 ${result.deletedCount ?? 0} 条`
      );
    }

    async function exportContextItems() {
      await runContextMaintenance(
        async () => {
          const result = await contextApi.exportItems(contextFilters.value);
          const blob = new Blob([result.jsonl], { type: "application/x-ndjson;charset=utf-8" });
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = `context-items-${Date.now()}.jsonl`;
          link.click();
          URL.revokeObjectURL(url);
          return result;
        },
        (result) => `已导出 ${result.count ?? 0} 条`
      );
    }

    async function importContextItems() {
      const jsonl = window.prompt("粘贴 context items JSONL");
      if (!jsonl?.trim()) return;
      await runContextMaintenance(
        () => contextApi.importItems(jsonl),
        (result) => `已导入 ${result.importedCount ?? 0} 条，跳过 ${result.skippedCount ?? 0} 条`
      );
    }

    async function compactContextUser() {
      const userId = contextFilters.value.userId?.trim();
      if (!userId) {
        toast.push({ type: "error", message: "先输入用户 ID" });
        return;
      }
      await runContextMaintenance(
        () => contextApi.compactUser({ userId, olderThanDays: 1, maxSourceChunks: 20 }),
        (result) => `已压缩 ${result.compactedCount ?? 0} 条`
      );
    }

    async function sweepDeletedContextItems() {
      await runContextMaintenance(
        () => contextApi.sweepDeleted({ deletedBeforeDays: 14 }),
        (result) => `已硬清理 ${result.deletedCount ?? 0} 条`
      );
    }

    async function clearContextEmbeddings() {
      if (!window.confirm("清空当前过滤范围的 embedding？下次检索会重新生成。")) return;
      await runContextMaintenance(
        () => contextApi.clearEmbeddings(contextFilters.value),
        (result) => `已清空 ${result.deletedCount ?? 0} 条 embedding`
      );
    }

    async function resetContextIndex() {
      await runContextMaintenance(
        () => contextApi.resetIndex({ userId: contextFilters.value.userId?.trim() || undefined }),
        (result) => `已重置 ${result.resetCount ?? 0} 个索引`
      );
    }

    async function rebuildContextIndex() {
      const forceReembed = window.confirm("是否强制重新生成 embedding？选择取消时只补齐缺失 embedding 并重建索引。");
      await runContextMaintenance(
        () => contextApi.rebuildIndex({
          userId: contextFilters.value.userId?.trim() || undefined,
          forceReembed,
          embeddingBatchSize: 64
        }),
        (result) => `已处理 ${result.userCount} 个用户，写入 ${result.embeddedCount} 条 embedding，索引 ${result.indexedCount} 条`
      );
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
      if (!selectedKey.value || !model.value || !canSubmit.value) return;
      saving.value = true;
      try {
        const res = await editorApi.save(selectedKey.value, editorState.draftValue.value);
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
      editorState.draftValue.value = value;
    }

    function formatSize(bytes: number): string {
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    function formatTime(ms: number): string {
      return new Date(ms).toLocaleString("zh-CN");
    }

    function formatContextMeta(item: ContextManagementItem): string {
      return [
        item.scope,
        item.sourceType,
        item.retrievalPolicy,
        item.status,
        item.userId ? `user:${item.userId}` : null,
        item.sessionId ? `session:${item.sessionId}` : null,
        item.pinned ? "pinned" : null
      ].filter(Boolean).join(" · ");
    }

    function resourceBadge(resourceEntry: DataListResource): string {
      if (resourceEntry.source === "context") {
        return "上下文";
      }
      if (resourceEntry.source === "editor") {
        if (!resourceEntry.editable) return "只读";
        return resourceEntry.kind === "layered" ? "编辑器" : "JSON";
      }
      return resourceEntry.kind === "directory_json" ? "目录" : "JSON";
    }

    return {
      resources,
      selectedKey,
      selectedItemKey,
      selectedResource,
      resource,
      model,
      itemDetail,
      contextItems,
      contextTotal,
      contextFilters,
      contextStatus,
      deletingContextItemId,
      pinningContextItemId,
      contextMaintenanceBusy,
      loading,
      loadingItem,
      saving,
      validating,
      draftValue: editorState.draftValue,
      referenceValue: editorState.referenceValue,
      storedDraftValue: editorState.storedDraftValue,
      effectiveValue: editorState.effectiveValue,
      isDirty: editorState.isDirty,
      canSubmit,
      formattedJson,
      formattedItemJson,
      mobileHeaderTitle,
      resetState,
      refreshResources,
      selectResource,
      selectDirectoryItem,
      refreshSelected,
      refreshContextItems,
      deleteContextItem,
      editContextItem,
      toggleContextItemPinned,
      bulkDeleteContextItems,
      exportContextItems,
      importContextItems,
      compactContextUser,
      sweepDeletedContextItems,
      clearContextEmbeddings,
      resetContextIndex,
      rebuildContextIndex,
      updateContextFilter,
      reloadFromServer,
      validate,
      save,
      updateDraft,
      formatSize,
      formatTime,
      formatContextMeta,
      resourceBadge
    };
});

export type { DataResourceSummary, DataResource, DataResourceItem, DirectoryItem, EditorModel, EditorResourceSummary };
