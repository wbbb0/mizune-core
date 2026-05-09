import { computed, defineComponent, h, ref, watch, type ComputedRef, type Ref } from "vue";
import { useEditorDraftState } from "@workbench-kit/vue-resource-editor";
import { useWorkbenchNavigation, useWorkbenchWindows } from "@workbench-kit/vue-workbench";
import { createSharedSectionState } from "@/composables/sections/sharedSectionState";
import { contextApi, type ContextItemFilters, type ContextManagementItem, type ContextStatus } from "@/api/context";
import { dataApi, type DataResourceSummary, type DataResource, type DataResourceItem, type DirectoryItem, type DataResourceRowsResult } from "@/api/data";
import { editorApi, type EditorModel, type EditorResourceSummary } from "@/api/editor";
import { useWorkbenchToasts } from "@workbench-kit/vue-workbench";
import ContextItemsControlPanel from "@/sections/data/ContextItemsControlPanel.vue";

type DataListResource =
  | {
      id: string;
      key: string;
      title: string;
      source: "registry";
      kind: DataResourceSummary["shape"];
      editable: boolean;
    }
  | {
      id: string;
      key: string;
      title: string;
      source: "editor";
      kind: EditorResourceSummary["kind"];
      editable: boolean;
    }
  | {
      id: "context:context_items";
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
  resourceRows: Ref<DataResourceRowsResult | null>;
  resourceDirectoryItems: ComputedRef<DirectoryItem[]>;
  registryDraftValue: Ref<unknown>;
  registryStoredValue: Ref<unknown>;
  registryRowDraftValue: Ref<unknown>;
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
  registryCanSubmit: ComputedRef<boolean>;
  formattedJson: ComputedRef<string>;
  formattedItemJson: ComputedRef<string>;
  formattedRowsJson: ComputedRef<string>;
  mobileHeaderTitle: ComputedRef<string>;
  resetState: () => void;
  refreshResources: () => Promise<void>;
  selectResource: (id: string) => void;
  selectDirectoryItem: (key: string) => void;
  refreshSelected: () => Promise<void>;
  refreshContextItems: () => Promise<void>;
  openContextFiltersDialog: () => Promise<void>;
  deleteContextItem: (itemId: string) => Promise<void>;
  createRegistryRow: () => Promise<void>;
  deleteRegistryRow: (row: unknown) => Promise<void>;
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
  updateRegistryDraft: (value: unknown) => void;
  updateRegistryRowDraft: (value: unknown) => void;
  saveRegistrySingleton: () => Promise<void>;
  formatSize: (bytes: number | undefined) => string;
  formatTime: (ms: number | undefined) => string;
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
    const resourceRows = ref<DataResourceRowsResult | null>(null);
    const registryDraftValue = ref<unknown>(null);
    const registryStoredValue = ref<unknown>(null);
    const registryRowDraftValue = ref<unknown>({});
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
    const windows = useWorkbenchWindows();
    const editorState = useEditorDraftState(model);
    let stateVersion = 0;

    const selectedResource = computed(() =>
      resources.value.find((entry) => entry.id === selectedKey.value) ?? null
    );
    const canSubmit = computed(() => !!selectedResource.value?.editable && editorState.isDirty.value && !validating.value && !saving.value);
    const registryCanSubmit = computed(() =>
      selectedResource.value?.source === "registry"
      && resource.value?.shape === "singleton"
      && resource.value.editable
      && JSON.stringify(registryDraftValue.value) !== JSON.stringify(registryStoredValue.value)
      && !saving.value
      && !loading.value
    );

    const formattedJson = computed(() => {
      if (!resource.value || (resource.value.shape !== "file" && resource.value.shape !== "singleton")) return "";
      return JSON.stringify(resource.value.value, null, 2);
    });

    const formattedItemJson = computed(() =>
      itemDetail.value ? JSON.stringify(itemDetail.value.value, null, 2) : ""
    );

    const formattedRowsJson = computed(() =>
      resourceRows.value ? JSON.stringify(resourceRows.value.rows, null, 2) : ""
    );

    const resourceDirectoryItems = computed<DirectoryItem[]>(() =>
      resource.value?.shape === "directory" ? resource.value.items : []
    );

    const mobileHeaderTitle = computed(() => {
      if (selectedResource.value?.source === "editor" && model.value) {
        return model.value.title;
      }
      if (selectedResource.value?.source === "registry" && resource.value) {
        if (resource.value.shape === "directory" && itemDetail.value) {
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
      resourceRows.value = null;
      registryDraftValue.value = null;
      registryStoredValue.value = null;
      registryRowDraftValue.value = {};
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
            id: `editor:${entry.key}`,
            title: entry.title,
            source: "editor" as const,
            kind: entry.kind,
            editable: entry.editable
          })),
        ...dataRes.resources.map((entry) => ({
          key: entry.key,
          id: `registry:${entry.key}`,
          title: entry.title,
          source: "registry" as const,
          kind: entry.shape,
          editable: entry.editable
        })),
        {
          key: "context_items",
          id: "context:context_items",
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
        resourceRows.value = null;
        registryDraftValue.value = null;
        registryStoredValue.value = null;
        registryRowDraftValue.value = {};
        contextItems.value = [];
        contextTotal.value = 0;
        contextStatus.value = null;
        selectedItemKey.value = null;
        if (!key) return;

        const target = resources.value.find((entry) => entry.id === key);
        if (!target) return;

        loading.value = true;
        try {
          if (target.source === "registry") {
            const res = await dataApi.get(target.key);
            if (isStale(requestVersion) || selectedKey.value !== requestKey) {
              return;
            }
            resource.value = res.resource;
            if (res.resource.shape === "singleton") {
              registryStoredValue.value = structuredClone(res.resource.value);
              registryDraftValue.value = structuredClone(res.resource.value);
            }
            if (res.resource.shape === "collection" || res.resource.shape === "log") {
              const rows = await dataApi.listRows(target.key, { limit: 100 });
              if (isStale(requestVersion) || selectedKey.value !== requestKey) {
                return;
              }
              resourceRows.value = rows;
            }
            return;
          }

          if (target.source === "context") {
            await loadContextView(requestVersion);
            return;
          }

          const res = await editorApi.load(target.key);
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
        const requestResourceId = selectedKey.value;
        const requestResourceKey = selectedResource.value?.key ?? null;
        itemDetail.value = null;
        if (!itemKey || !selectedKey.value || selectedResource.value?.source !== "registry") return;
        loadingItem.value = true;
        try {
          const res = await dataApi.getItem(selectedResource.value.key, itemKey);
          if (
            isStale(requestVersion)
            || selectedKey.value !== requestResourceId
            || selectedResource.value?.key !== requestResourceKey
            || selectedItemKey.value !== requestItemKey
          ) {
            return;
          }
          itemDetail.value = res.item;
        } finally {
          if (!isStale(requestVersion) && selectedItemKey.value === requestItemKey) {
            loadingItem.value = false;
          }
        }
    });

    function selectResource(id: string) {
      selectedKey.value = id;
      workbenchNavigation.showArea("mainArea");
    }

    function selectDirectoryItem(key: string) {
      selectedItemKey.value = key;
      workbenchNavigation.showArea("mainArea");
    }

    async function refreshSelected() {
      const requestVersion = stateVersion;
      const requestResourceId = selectedKey.value;
      const requestResource = selectedResource.value;
      if (!requestResourceId || !requestResource) return;
      loading.value = true;
      try {
        if (requestResource.source === "registry") {
          const res = await dataApi.get(requestResource.key);
          if (isStale(requestVersion) || selectedKey.value !== requestResourceId) {
            return;
          }
          resource.value = res.resource;
          if (res.resource.shape === "singleton") {
            registryStoredValue.value = structuredClone(res.resource.value);
            registryDraftValue.value = structuredClone(res.resource.value);
          }
          if (res.resource.shape === "collection" || res.resource.shape === "log") {
            const rows = await dataApi.listRows(requestResource.key, { limit: 100 });
            if (isStale(requestVersion) || selectedKey.value !== requestResourceId) {
              return;
            }
            resourceRows.value = rows;
          } else {
            resourceRows.value = null;
          }
          return;
        }

        if (requestResource.source === "context") {
          await loadContextView(requestVersion);
          return;
        }

        const res = await editorApi.load(requestResource.key);
        if (isStale(requestVersion) || selectedKey.value !== requestResourceId) {
          return;
        }
        model.value = res.editor;
      } finally {
        if (!isStale(requestVersion) && selectedKey.value === requestResourceId) {
          loading.value = false;
        }
      }
    }

    async function refreshContextItems() {
      const requestVersion = stateVersion;
      const requestResourceId = selectedKey.value;
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
        if (!isStale(requestVersion) && selectedKey.value === requestResourceId) {
          loading.value = false;
        }
      }
    }

    async function applyContextFilters(filters: ContextItemFilters) {
      contextFilters.value = {
        ...contextFilters.value,
        ...filters,
        userId: filters.userId?.trim() ?? "",
        scope: filters.scope ?? "",
        sourceType: filters.sourceType ?? "",
        status: filters.status ?? "",
        offset: filters.offset ?? 0
      };
      await refreshContextItems();
    }

    async function openContextFiltersDialog() {
      const context = { kind: "data-context-controls", id: "context_items" };
      windows.closeByContext(context);
      const ControlPanelWindow = defineComponent({
        name: "ContextItemsControlPanelWindow",
        props: {
          windowId: {
            type: String,
            required: true
          }
        },
        setup(props) {
          async function applyFiltersFromPanel(filters: ContextItemFilters) {
            await applyContextFilters(filters);
          }

          return () => h(ContextItemsControlPanel, {
            currentFilters: contextFilters.value,
            contextTotal: contextTotal.value,
            contextStatus: contextStatus.value,
            loading: loading.value,
            maintenanceBusy: contextMaintenanceBusy.value,
            applyFilters: applyFiltersFromPanel,
            refreshContextItems,
            exportContextItems,
            importContextItems,
            compactContextUser,
            sweepDeletedContextItems,
            clearContextEmbeddings: () => clearContextEmbeddings({ parentWindowId: props.windowId }),
            resetContextIndex,
            rebuildContextIndex: () => rebuildContextIndex({ parentWindowId: props.windowId }),
            bulkDeleteContextItems: () => bulkDeleteContextItems({ parentWindowId: props.windowId })
          });
        }
      });
      windows.openDialogSync({
        title: "上下文记忆管理",
        description: "筛选、导入导出与维护操作。",
        size: "md",
        modal: false,
        showCloseButton: true,
        footer: "hidden",
        closeOnBackdrop: false,
        closeOnEscape: true,
        context,
        blocks: [
          {
            kind: "component",
            component: ControlPanelWindow
          }
        ]
      } as never);
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
      if (!await confirmWorkbenchAction({
        title: "确认删除上下文记忆",
        content: "这条上下文记忆会被标记为 deleted，后续维护任务会清理已删除数据。",
        confirmLabel: "删除",
        variant: "danger"
      })) return;
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
      const slotKey = window.prompt("slotKey，留空表示无", item.slotKey ?? "");
      if (slotKey == null) return;
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
          slotKey: slotKey.trim() || null,
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

    async function bulkDeleteContextItems(options: { parentWindowId?: string } = {}) {
      if (!await confirmWorkbenchAction({
        title: "确认批量删除",
        content: "将按当前筛选条件批量标记上下文记忆为 deleted。请确认筛选条件正确。",
        confirmLabel: "批量删除",
        variant: "danger",
        parentWindowId: options.parentWindowId
      })) return;
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

    async function clearContextEmbeddings(options: { parentWindowId?: string } = {}) {
      if (!await confirmWorkbenchAction({
        title: "确认清空 embedding",
        content: "将清空当前筛选范围的 embedding。下次检索或维护时会重新生成。",
        confirmLabel: "清空 embedding",
        variant: "danger",
        parentWindowId: options.parentWindowId
      })) return;
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

    async function rebuildContextIndex(options: { parentWindowId?: string } = {}) {
      const forceReembed = await chooseRebuildContextIndexMode(options);
      if (forceReembed == null) {
        return;
      }
      await runContextMaintenance(
        () => contextApi.rebuildIndex({
          userId: contextFilters.value.userId?.trim() || undefined,
          forceReembed,
          embeddingBatchSize: 64
        }),
        (result) => `已处理 ${result.userCount} 个用户，写入 ${result.embeddedCount} 条 embedding，索引 ${result.indexedCount} 条`
      );
    }

    async function confirmWorkbenchAction(input: {
      title: string;
      content: string;
      confirmLabel: string;
      variant?: "primary" | "secondary" | "danger";
      parentWindowId?: string;
    }): Promise<boolean> {
      const result = await windows.openDialog({
        ...(input.parentWindowId ? { kind: "child-dialog" as const, parentId: input.parentWindowId } : {}),
        title: input.title,
        size: "sm",
        modal: true,
        blocks: [
          {
            kind: "text",
            content: input.content
          }
        ],
        actions: [
          {
            id: "confirm",
            label: input.confirmLabel,
            variant: input.variant ?? "primary",
            run: async () => ({ confirmed: true })
          }
        ]
      });
      return result.reason === "action" && result.actionId === "confirm";
    }

    async function chooseRebuildContextIndexMode(options: { parentWindowId?: string } = {}): Promise<boolean | null> {
      const result = await windows.openDialog({
        ...(options.parentWindowId ? { kind: "child-dialog" as const, parentId: options.parentWindowId } : {}),
        title: "重建上下文索引",
        description: "选择 embedding 处理方式。",
        size: "sm",
        modal: true,
        blocks: [
          {
            kind: "text",
            content: "只补齐缺失 embedding 通常更快；强制重新生成会重算当前范围内的 embedding。"
          }
        ],
        actions: [
          {
            id: "missing-only",
            label: "只补齐缺失",
            variant: "secondary",
            run: async () => ({ forceReembed: false })
          },
          {
            id: "force",
            label: "强制重新生成",
            variant: "danger",
            run: async () => ({ forceReembed: true })
          }
        ]
      });
      if (result.reason !== "action") {
        return null;
      }
      return result.actionId === "force";
    }

    async function reloadFromServer() {
      const requestVersion = stateVersion;
      const requestResourceId = selectedKey.value;
      const requestResource = selectedResource.value;
      if (!requestResourceId || !requestResource || !model.value || loading.value || saving.value || validating.value) return;
      loading.value = true;
      try {
        const res = await editorApi.load(requestResource.key);
        if (isStale(requestVersion) || selectedKey.value !== requestResourceId) {
          return;
        }
        model.value = res.editor;
      } finally {
        if (!isStale(requestVersion) && selectedKey.value === requestResourceId) {
          loading.value = false;
        }
      }
    }

    async function validate() {
      const requestVersion = stateVersion;
      if (!selectedResource.value || !model.value || !canSubmit.value) return;
      validating.value = true;
      try {
        await editorApi.validate(selectedResource.value.key, editorState.draftValue.value);
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
      if (!selectedResource.value || !model.value || !canSubmit.value) return;
      saving.value = true;
      try {
        const res = await editorApi.save(selectedResource.value.key, editorState.draftValue.value);
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

    function updateRegistryDraft(value: unknown) {
      registryDraftValue.value = value;
    }

    function updateRegistryRowDraft(value: unknown) {
      registryRowDraftValue.value = value;
    }

    async function createRegistryRow() {
      const requestVersion = stateVersion;
      const requestResourceId = selectedKey.value;
      const requestResource = selectedResource.value;
      if (!requestResourceId || requestResource?.source !== "registry" || resource.value?.shape !== "collection" || !resource.value.editable) return;
      saving.value = true;
      try {
        await dataApi.createRow(requestResource.key, registryRowDraftValue.value);
        if (isStale(requestVersion) || selectedKey.value !== requestResourceId) {
          return;
        }
        resourceRows.value = await dataApi.listRows(requestResource.key, { limit: 100 });
        registryRowDraftValue.value = {};
        toast.push({ type: "success", message: "已新增" });
      } catch (error: unknown) {
        if (isStale(requestVersion)) {
          return;
        }
        toast.push({ type: "error", message: error instanceof Error ? error.message : "新增失败" });
      } finally {
        if (!isStale(requestVersion) && selectedKey.value === requestResourceId) {
          saving.value = false;
        }
      }
    }

    async function deleteRegistryRow(row: unknown) {
      const requestVersion = stateVersion;
      const requestResourceId = selectedKey.value;
      const requestResource = selectedResource.value;
      const rowId = getRegistryRowId(row);
      if (!requestResourceId || requestResource?.source !== "registry" || resource.value?.shape !== "collection" || !resource.value.editable || !rowId) return;
      if (!await confirmWorkbenchAction({
        title: "确认删除条目",
        content: "该条目会从当前数据表中删除。",
        confirmLabel: "删除",
        variant: "danger"
      })) return;
      saving.value = true;
      try {
        await dataApi.deleteRow(requestResource.key, rowId);
        if (isStale(requestVersion) || selectedKey.value !== requestResourceId) {
          return;
        }
        resourceRows.value = await dataApi.listRows(requestResource.key, { limit: 100 });
        toast.push({ type: "success", message: "已删除" });
      } catch (error: unknown) {
        if (isStale(requestVersion)) {
          return;
        }
        toast.push({ type: "error", message: error instanceof Error ? error.message : "删除失败" });
      } finally {
        if (!isStale(requestVersion) && selectedKey.value === requestResourceId) {
          saving.value = false;
        }
      }
    }

    async function saveRegistrySingleton() {
      const requestVersion = stateVersion;
      const requestResourceId = selectedKey.value;
      const requestResource = selectedResource.value;
      if (!requestResourceId || requestResource?.source !== "registry" || !registryCanSubmit.value) return;
      saving.value = true;
      try {
        const res = await dataApi.patchSingleton(requestResource.key, registryDraftValue.value);
        if (isStale(requestVersion) || selectedKey.value !== requestResourceId) {
          return;
        }
        if (resource.value?.shape === "singleton") {
          resource.value = {
            ...resource.value,
            value: res.value
          };
        }
        registryStoredValue.value = structuredClone(res.value);
        registryDraftValue.value = structuredClone(res.value);
        toast.push({ type: "success", message: "已保存" });
      } catch (error: unknown) {
        if (isStale(requestVersion)) {
          return;
        }
        toast.push({ type: "error", message: error instanceof Error ? error.message : "保存失败" });
      } finally {
        if (!isStale(requestVersion) && selectedKey.value === requestResourceId) {
          saving.value = false;
        }
      }
    }

    function formatSize(bytes: number | undefined): string {
      if (bytes == null) return "-";
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    function formatTime(ms: number | undefined): string {
      if (ms == null) return "-";
      return new Date(ms).toLocaleString("zh-CN");
    }

    function formatContextMeta(item: ContextManagementItem): string {
      return [
        item.scope,
        item.sourceType,
        item.retrievalPolicy,
        item.status,
        item.slotKey ? `slot:${item.slotKey}` : null,
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
      if (resourceEntry.source === "registry") {
        if (resourceEntry.kind === "directory") return "目录";
        if (resourceEntry.kind === "collection") return resourceEntry.editable ? "表" : "只读表";
        if (resourceEntry.kind === "log") return "日志";
        if (resourceEntry.kind === "singleton") return resourceEntry.editable ? "单例" : "只读";
        return "文件";
      }
      return "";
    }

    return {
      resources,
      selectedKey,
      selectedItemKey,
      selectedResource,
      resource,
      model,
      itemDetail,
      resourceRows,
      resourceDirectoryItems,
      registryDraftValue,
      registryStoredValue,
      registryRowDraftValue,
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
      registryCanSubmit,
      formattedJson,
      formattedItemJson,
      formattedRowsJson,
      mobileHeaderTitle,
      resetState,
      refreshResources,
      selectResource,
      selectDirectoryItem,
      refreshSelected,
      refreshContextItems,
      openContextFiltersDialog,
      deleteContextItem,
      createRegistryRow,
      deleteRegistryRow,
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
      updateRegistryDraft,
      updateRegistryRowDraft,
      saveRegistrySingleton,
      formatSize,
      formatTime,
      formatContextMeta,
      resourceBadge
    };
});

function getRegistryRowId(row: unknown): string | null {
  if (!row || typeof row !== "object" || !("id" in row)) {
    return null;
  }
  const id = (row as { id?: unknown }).id;
  return typeof id === "string" && id ? id : null;
}

export type { DataResourceSummary, DataResource, DataResourceItem, DirectoryItem, EditorModel, EditorResourceSummary };
