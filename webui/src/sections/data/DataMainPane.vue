<script setup lang="ts">
import { computed, ref } from "vue";
import { RefreshCw, ChevronRight, ChevronDown, Save, Trash2, Pin, Pencil, SlidersHorizontal, Plus } from "lucide-vue-next";
import { SchemaNode } from "@workbench-kit/vue";
import { useDataSection } from "@/composables/sections/useDataSection";
import { useElementWidth } from "@/composables/useElementWidth";
import DataModelExplorerPane from "./DataModelExplorerPane.vue";
import { WorkbenchAreaHeader, WorkbenchEmptyState, WorkbenchListItem } from "@workbench-kit/vue";

const {
  selectedKey,
  selectedResource,
  selectedItemKey,
  resource,
  model,
  itemDetail,
  resourceRows,
  selectedRegistryRow,
  resourceDirectoryItems,
  registryDraftValue,
  registryStoredValue,
  contextItems,
  contextTotal,
  contextFilters,
  contextStatus,
  deletingContextItemId,
  pinningContextItemId,
  contextMaintenanceBusy,
  loading,
  loadingItem,
  loadingMoreRows,
  saving,
  validating,
  draftValue,
  referenceValue,
  storedDraftValue,
  effectiveValue,
  canSubmit,
  registryCanSubmit,
  formattedJson,
  formattedItemJson,
  formattedRowsJson,
  refreshContextItems,
  openContextFiltersDialog,
  deleteContextItem,
  openCreateRegistryRowDialog,
  saveRegistryRow,
  deleteRegistryRow,
  loadRegistryRowsPage,
  editContextItem,
  toggleContextItemPinned,
  selectRegistryRow,
  selectDirectoryItem,
  refreshSelected,
  reloadFromServer,
  validate,
  save,
  saveRegistrySingleton,
  updateDraft,
  updateRegistryDraft,
  updateRegistryExistingRowDraft,
  getRegistryExistingRowDraft,
  canSaveRegistryRow,
  formatSize,
  formatTime,
  formatContextMeta
} = useDataSection();

const paneRef = ref<HTMLElement | null>(null);
const paneWidth = useElementWidth(paneRef);
const compactPane = computed(() => paneWidth.value > 0 && paneWidth.value < 720);
const registryRowsPage = computed(() => resourceRows.value ? Math.floor(resourceRows.value.offset / resourceRows.value.limit) + 1 : 1);
const registryRowsPageSize = computed(() => resourceRows.value?.limit ?? 50);

async function selectModelRow(row: unknown) {
  await selectRegistryRow(row, { showDetailPane: false });
}

async function updateRegistryRowsPage(page: number) {
  await loadRegistryRowsPage(page, registryRowsPageSize.value);
}

async function updateRegistryRowsPageSize(pageSize: number) {
  await loadRegistryRowsPage(1, pageSize);
}

function dataModelStorageKey(resourceKey: string, name: string): string {
  return `data.model.${encodeURIComponent(resourceKey)}.${name}`;
}
</script>

<template>
  <div ref="paneRef" class="flex h-full flex-col overflow-hidden">
    <WorkbenchEmptyState v-if="!selectedKey" message="← 选择一个数据资源" />

    <WorkbenchEmptyState v-else-if="loading">
      <template #icon>
        <RefreshCw :size="16" class="spin" :stroke-width="2" />
      </template>
      加载中…
    </WorkbenchEmptyState>

    <template v-else-if="selectedResource?.source === 'editor' && model">
      <WorkbenchAreaHeader class="flex-wrap gap-2.5 px-4" :class="compactPane ? 'items-start' : ''" :uppercase="false">
        <span class="shrink-0 rounded-full bg-surface-muted px-1.5 text-small text-text-subtle">{{ model.kind }}</span>
        <template v-if="model.kind === 'layered'">
          <span class="shrink-0 text-small text-text-muted">层次：</span>
          <span
            v-for="layer in model.layers"
            :key="layer.key"
            class="shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-small text-text-muted"
            :class="{ 'bg-accent text-text-on-accent': layer.key === model.writableLayerKey }"
          >{{ layer.key }}</span>
        </template>
        <div class="flex gap-1.5" :class="compactPane ? 'w-full flex-wrap justify-end' : 'ml-auto'">
          <button class="btn btn-secondary" :disabled="loading || saving || validating || !model" @click="reloadFromServer">
            <RefreshCw :size="13" :stroke-width="2" />
            重新读取
          </button>
          <button class="btn btn-secondary" :disabled="!canSubmit" @click="validate">
            <RefreshCw v-if="validating" :size="13" class="spin" :stroke-width="2" />
            验证
          </button>
          <button class="btn btn-primary" :disabled="!canSubmit" @click="save">
            <Save :size="13" :stroke-width="1.5" />
            {{ saving ? "保存中…" : "保存" }}
          </button>
        </div>
      </WorkbenchAreaHeader>

      <div class="scrollbar-thin flex-1 overflow-y-auto px-4 py-3">
        <SchemaNode
          :node="model.uiTree"
          :model-value="draftValue"
          :inherited="referenceValue"
          :default-value="model.schemaDefaultValue"
          :stored-value="storedDraftValue"
          :effective-value="effectiveValue"
          :editor-features="model.editorFeatures"
          :depth="0"
          @update:model-value="updateDraft"
        />
      </div>
    </template>

    <template v-else-if="selectedResource?.source === 'context'">
      <WorkbenchAreaHeader class="gap-2 overflow-hidden px-4" :uppercase="false">
        <div class="scrollbar-thin flex min-w-0 flex-1 items-center gap-2 overflow-x-auto whitespace-nowrap py-1">
          <button class="btn btn-secondary shrink-0" :disabled="loading" title="管理上下文记忆" @click="openContextFiltersDialog">
            <SlidersHorizontal :size="13" :stroke-width="2" />
            管理
          </button>
          <span class="shrink-0 text-small text-text-subtle">{{ contextTotal }} 条</span>
          <span v-if="contextFilters.userId" class="shrink-0 rounded bg-surface-muted px-1.5 py-0.5 font-mono text-small text-text-subtle">user {{ contextFilters.userId }}</span>
          <span v-if="contextFilters.scope" class="shrink-0 rounded bg-surface-muted px-1.5 py-0.5 text-small text-text-subtle">{{ contextFilters.scope }}</span>
          <span v-if="contextFilters.sourceType" class="shrink-0 rounded bg-surface-muted px-1.5 py-0.5 text-small text-text-subtle">{{ contextFilters.sourceType }}</span>
          <span v-if="contextFilters.status" class="shrink-0 rounded bg-surface-muted px-1.5 py-0.5 text-small text-text-subtle">{{ contextFilters.status }}</span>
          <span v-if="contextStatus" class="shrink-0 text-small text-text-subtle">
            raw {{ contextStatus.stats.rawMessages }} · vec {{ contextStatus.stats.embeddings }}
          </span>
          <span
            v-if="contextStatus"
            class="shrink-0 rounded bg-surface-muted px-1.5 py-0.5 text-small"
            :class="contextStatus.store.available ? 'text-success' : 'text-danger'"
            :title="[
              contextStatus.store.disabledReason || contextStatus.store.dbPath,
              ...(contextStatus.store.tableGroups ?? []).map((group) => `${group.groupId} v${group.actualSchemaVersion ?? '?'} / ${group.schemaVersion}${group.lastResetReason ? ` · ${group.lastResetReason}` : ''}`)
            ].join('\n')"
          >
            store {{ contextStatus.store.available ? "ok" : "down" }}
          </span>
          <span v-if="contextStatus?.store.tableGroups?.length" class="shrink-0 rounded bg-surface-muted px-1.5 py-0.5 text-small text-text-subtle">
            schema {{ contextStatus.store.tableGroups.length }}
          </span>
          <span
            v-if="contextStatus"
            class="shrink-0 rounded bg-surface-muted px-1.5 py-0.5 text-small"
            :class="contextStatus.embedding.configured ? 'text-success' : 'text-warning'"
            :title="contextStatus.embedding.modelRefs.join(', ') || '未配置 embedding 模型'"
          >
            embedding {{ contextStatus.embedding.configured ? "ok" : "missing" }}
          </span>
        </div>
        <template #actions>
          <div class="scrollbar-thin flex max-w-full items-center gap-1 overflow-x-auto whitespace-nowrap py-1">
            <button class="btn-ghost shrink-0" :disabled="loading || contextMaintenanceBusy" title="刷新" @click="refreshContextItems">
              <RefreshCw :size="13" :stroke-width="2" :class="{ spin: loading }" />
            </button>
          </div>
        </template>
      </WorkbenchAreaHeader>

      <div class="scrollbar-thin flex-1 overflow-y-auto">
        <div
          v-for="item in contextItems"
          :key="item.itemId"
          class="border-b border-border-subtle px-4 py-3"
        >
          <div class="flex min-w-0 items-start gap-3">
            <div class="min-w-0 flex-1">
              <div class="flex min-w-0 items-center gap-2">
                <span class="truncate text-small font-medium text-text-primary">{{ item.title || item.itemId }}</span>
                <span class="shrink-0 rounded bg-surface-muted px-1.5 py-0.5 text-small text-text-subtle">{{ item.sensitivity }}</span>
              </div>
              <div class="mt-1 truncate font-mono text-small text-text-subtle">{{ formatContextMeta(item) }}</div>
            </div>
            <div class="scrollbar-thin flex max-w-[45%] shrink-0 gap-1 overflow-x-auto whitespace-nowrap pb-1">
              <button
                class="btn-ghost shrink-0"
                :title="item.pinned ? '取消固定' : '固定'"
                :disabled="pinningContextItemId === item.itemId"
                @click="toggleContextItemPinned(item)"
              >
                <RefreshCw v-if="pinningContextItemId === item.itemId" :size="13" class="spin" :stroke-width="2" />
                <Pin v-else :size="13" :stroke-width="2" :class="{ 'text-accent': item.pinned }" />
              </button>
              <button
                class="btn-ghost shrink-0"
                title="编辑"
                @click="editContextItem(item)"
              >
                <Pencil :size="13" :stroke-width="2" />
              </button>
              <button
                class="btn-ghost shrink-0"
                title="删除"
                :disabled="deletingContextItemId === item.itemId"
                @click="deleteContextItem(item.itemId)"
              >
                <RefreshCw v-if="deletingContextItemId === item.itemId" :size="13" class="spin" :stroke-width="2" />
                <Trash2 v-else :size="13" :stroke-width="2" />
              </button>
            </div>
          </div>
          <p class="my-2 whitespace-pre-wrap wrap-break-word text-ui leading-6 text-text-secondary">{{ item.text }}</p>
          <div class="flex flex-wrap gap-2 font-mono text-small text-text-subtle">
            <span>{{ item.itemId }}</span>
            <span>{{ formatTime(item.updatedAt) }}</span>
            <span v-if="item.lastRetrievedAt">retrieved {{ formatTime(item.lastRetrievedAt) }}</span>
          </div>
        </div>
        <WorkbenchEmptyState v-if="contextItems.length === 0" class="justify-center px-3 py-6 text-center text-small text-text-subtle" message="暂无上下文记忆" />
      </div>
    </template>

    <template v-else-if="selectedResource?.source === 'registry' && resource">
      <WorkbenchAreaHeader class="gap-2.5 overflow-hidden px-4" :uppercase="false">
        <span class="rounded-full bg-surface-muted px-1.5 text-small text-text-subtle">{{ resource.shape }}</span>
        <span class="truncate font-mono text-small text-text-subtle">{{ resource.storage.path || resource.storage.tables?.join(", ") || resource.storage.tableGroup || resource.storage.database }}</span>
        <template #actions>
        <button class="btn-ghost ml-auto" :disabled="loading" @click="refreshSelected">
          <RefreshCw :size="13" :stroke-width="2" :class="{ spin: loading }" />
        </button>
        <button
          v-if="resource.shape === 'collection' && resource.accessMode === 'editable' && resource.rowOperations?.create && resource.rowUiTree"
          class="btn btn-primary"
          :disabled="saving"
          @click="openCreateRegistryRowDialog"
        >
          <Plus :size="13" :stroke-width="1.5" />
          新增
        </button>
        <button
          v-if="resource.shape === 'singleton' && resource.accessMode === 'editable'"
          class="btn btn-primary"
          :disabled="!registryCanSubmit"
          @click="saveRegistrySingleton"
        >
          <Save :size="13" :stroke-width="1.5" />
          {{ saving ? "保存中…" : "保存" }}
        </button>
        </template>
      </WorkbenchAreaHeader>

      <div v-if="resource.shape === 'singleton' && resource.accessMode === 'editable' && resource.uiTree" class="scrollbar-thin flex-1 overflow-y-auto px-4 py-3">
        <SchemaNode
          :node="resource.uiTree"
          :model-value="registryDraftValue"
          :stored-value="registryStoredValue"
          :effective-value="registryDraftValue"
          :depth="0"
          @update:model-value="updateRegistryDraft"
        />
      </div>

      <div v-else-if="resource.shape === 'file' || resource.shape === 'singleton'" class="scrollbar-thin flex-1 overflow-auto px-4 py-3">
        <pre class="m-0 overflow-auto p-0 font-mono text-mono leading-6 text-text-primary whitespace-pre-wrap wrap-break-word">{{ formattedJson }}</pre>
      </div>

      <div
        v-else-if="resource.shape === 'collection' || resource.shape === 'log'"
        class="scrollbar-thin flex-1"
        :class="resource.model?.kind === 'table' ? 'flex min-h-0 flex-col overflow-hidden' : 'overflow-auto px-4 py-3'"
      >
        <div v-if="resource.model?.kind !== 'table'" class="mb-2 flex items-center gap-2 text-small text-text-subtle">
          <span>{{ resourceRows?.total ?? resourceRows?.rows.length ?? 0 }} 行</span>
          <span v-if="resourceRows">offset {{ resourceRows.offset }} · limit {{ resourceRows.limit }}</span>
        </div>
        <div v-if="resource.model?.kind !== 'table' && resource.shape === 'collection' && resource.accessMode === 'editable' && resource.rowOperations?.patch && resource.rowUiTree && resourceRows?.rows.length" class="space-y-3">
          <div
            v-for="(row, index) in resourceRows.rows"
            :key="`${index}`"
            class="border-b border-border-subtle pb-3"
          >
            <div class="mb-2 flex justify-end gap-1.5">
              <button class="btn-ghost" :disabled="!canSaveRegistryRow(row)" title="保存" @click="saveRegistryRow(row)">
                <Save :size="13" :stroke-width="1.5" />
              </button>
              <button v-if="resource.rowOperations?.delete" class="btn-ghost" :disabled="saving" title="删除" @click="deleteRegistryRow(row)">
                <Trash2 :size="13" :stroke-width="2" />
              </button>
            </div>
            <SchemaNode
              :node="resource.rowUiTree"
              :model-value="getRegistryExistingRowDraft(row)"
              :stored-value="row"
              :effective-value="getRegistryExistingRowDraft(row)"
              :depth="0"
              @update:model-value="updateRegistryExistingRowDraft(row, $event)"
            />
          </div>
        </div>
        <DataModelExplorerPane
          v-else-if="resource.model?.kind === 'table'"
          class="min-h-0 flex-1"
          :resource="resource"
          :rows="resourceRows?.rows ?? []"
          :page="registryRowsPage"
          :page-size="registryRowsPageSize"
          :total="resourceRows?.total"
          :loading="loadingMoreRows"
          :selected-row="selectedRegistryRow"
          :split-storage-key="dataModelStorageKey(resource.key, 'split')"
          :page-size-storage-key="dataModelStorageKey(resource.key, 'pageSize')"
          empty-message="暂无数据"
          @select-row="selectModelRow"
          @update:page="updateRegistryRowsPage"
          @update:page-size="updateRegistryRowsPageSize"
        />
        <pre v-else class="m-0 overflow-auto p-0 font-mono text-mono leading-6 text-text-primary whitespace-pre-wrap wrap-break-word">{{ formattedRowsJson }}</pre>
      </div>

      <div v-else class="flex min-h-0 flex-1 overflow-hidden">
        <div class="scrollbar-thin w-55 shrink-0 overflow-y-auto border-r border-border-default">
          <WorkbenchListItem
            v-for="item in resourceDirectoryItems"
            :key="item.key"
            :selected="selectedItemKey === item.key"
            multiline
            @select="selectDirectoryItem(item.key)"
          >
            <div class="tree-head">
              <component
                :is="selectedItemKey === item.key ? ChevronDown : ChevronRight"
                :size="13"
                :stroke-width="2"
                class="tree-chevron"
              />
              <span class="tree-label font-mono text-small">{{ item.title || item.key }}</span>
            </div>
            <div class="flex min-w-0 gap-2 pl-4.25">
              <span class="tree-meta">{{ formatSize(item.size) }}</span>
              <span class="tree-meta">{{ formatTime(item.updatedAt) }}</span>
            </div>
          </WorkbenchListItem>
          <WorkbenchEmptyState v-if="resourceDirectoryItems.length === 0" :centered="false" class="justify-center px-3 py-6 text-center text-small text-text-subtle" message="目录为空" />
        </div>

        <div class="scrollbar-thin flex flex-1 flex-col overflow-auto">
          <WorkbenchEmptyState v-if="!selectedItemKey" message="← 选择一个文件" />
          <WorkbenchEmptyState v-else-if="loadingItem">
            <template #icon>
              <RefreshCw :size="14" class="spin" :stroke-width="2" />
            </template>
          </WorkbenchEmptyState>
          <template v-else-if="itemDetail">
            <WorkbenchAreaHeader class="gap-3 px-4" :uppercase="false">
              <span class="flex-1 truncate font-mono text-small text-text-muted">{{ itemDetail.path }}</span>
              <span class="shrink-0 text-small text-text-subtle">{{ formatSize(itemDetail.size) }}</span>
              <span class="shrink-0 text-small text-text-subtle">{{ formatTime(itemDetail.updatedAt) }}</span>
            </WorkbenchAreaHeader>
            <pre class="m-0 overflow-auto px-4 py-3 font-mono text-mono leading-6 text-text-primary whitespace-pre-wrap wrap-break-word">{{ formattedItemJson }}</pre>
          </template>
        </div>
      </div>
    </template>
  </div>
</template>
