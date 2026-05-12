<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { dataApi, type DataResource, type DataResourceRowsResult } from "@/api/data";
import DataModelExplorerPane from "./DataModelExplorerPane.vue";

const props = defineProps<{
  resource: DataResource;
  rowsResult: DataResourceRowsResult;
  filters?: Record<string, unknown>;
  windowId?: string;
}>();

const rows = ref<DataResourceRowsResult>(props.rowsResult);
const selectedRow = ref<Record<string, unknown> | null>(firstRecord(props.rowsResult.rows));
const loadingRows = ref(false);
const page = computed(() => Math.floor(rows.value.offset / rows.value.limit) + 1);
const pageSize = computed(() => rows.value.limit);

function firstRecord(items: unknown[]): Record<string, unknown> | null {
  const item = items.find((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate));
  return item ? item as Record<string, unknown> : null;
}

function selectRow(row: unknown) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    selectedRow.value = null;
    return;
  }
  selectedRow.value = row as Record<string, unknown>;
}

async function loadRowsPage(nextPage: number, nextPageSize: number) {
  if (loadingRows.value) return;
  let normalizedPage = Math.max(1, Math.trunc(nextPage));
  const normalizedPageSize = Math.min(500, Math.max(1, Math.trunc(nextPageSize)));
  loadingRows.value = true;
  try {
    let next = await dataApi.listRows(props.resource.key, {
      offset: (normalizedPage - 1) * normalizedPageSize,
      limit: normalizedPageSize,
      ...(props.filters ? { filters: props.filters } : {})
    });
    if (next.total !== undefined && next.offset > 0 && next.rows.length === 0) {
      normalizedPage = next.total > 0 ? Math.ceil(next.total / normalizedPageSize) : 1;
      next = await dataApi.listRows(props.resource.key, {
        offset: (normalizedPage - 1) * normalizedPageSize,
        limit: normalizedPageSize,
        ...(props.filters ? { filters: props.filters } : {})
      });
    }
    rows.value = next;
    selectedRow.value = firstRecord(next.rows);
  } finally {
    loadingRows.value = false;
  }
}

async function updatePage(nextPage: number) {
  await loadRowsPage(nextPage, pageSize.value);
}

async function updatePageSize(nextPageSize: number) {
  await loadRowsPage(1, nextPageSize);
}

function dataModelDialogStorageKey(resourceKey: string, name: string): string {
  return `data.model.dialog.${encodeURIComponent(resourceKey)}.${name}`;
}

watch(() => props.rowsResult, (next) => {
  rows.value = next;
  selectedRow.value = firstRecord(next.rows);
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <DataModelExplorerPane
      class="min-h-0 flex-1"
      :resource="resource"
      :rows="rows.rows"
      :page="page"
      :page-size="pageSize"
      :total="rows.total"
      :loading="loadingRows"
      :selected-row="selectedRow"
      :window-id="windowId"
      :split-storage-key="dataModelDialogStorageKey(resource.key, 'split')"
      :page-size-storage-key="dataModelDialogStorageKey(resource.key, 'pageSize')"
      empty-message="暂无子表数据"
      @select-row="selectRow"
      @update:page="updatePage"
      @update:page-size="updatePageSize"
    />
  </div>
</template>
