<script setup lang="ts">
import { computed } from "vue";
import type { DataResource, DataResourceModelColumn } from "@/api/data";
import { PagedListPane, ResponsiveSplitPane, WorkbenchDataTable, type WorkbenchDataTableColumn } from "@workbench-kit/vue";
import DataModelRecordDetail from "./DataModelRecordDetail.vue";
import { formatModelCell, getModelListColumns, modelRowKey } from "./dataModelView";

const props = defineProps<{
  resource: DataResource;
  rows: unknown[];
  page: number;
  pageSize: number;
  loading: boolean;
  selectedRow: Record<string, unknown> | null;
  total?: number;
  windowId?: string;
  emptyMessage?: string;
  splitStorageKey?: string;
  pageSizeStorageKey?: string;
}>();

const emit = defineEmits<{
  "select-row": [row: unknown];
  "update:page": [page: number];
  "update:pageSize": [pageSize: number];
}>();

const columns = computed(() => getModelListColumns(props.resource));
const tableColumns = computed<WorkbenchDataTableColumn<unknown>[]>(() =>
  columns.value.map((column) => ({
    key: column.key,
    title: column.title || column.key,
    width: columnGridTrack(column),
    cellClass: column.role === "title" ? "font-medium text-text-secondary" : "font-mono text-text-muted"
  }))
);

function columnGridTrack(column: DataResourceModelColumn): string {
  if (column.listWidth) {
    return listWidthTrack(column.listWidth);
  }
  if (column.role === "badge" || column.role === "status" || column.type === "boolean") {
    return "minmax(5.5rem, max-content)";
  }
  if (column.role === "time") {
    return "minmax(10rem, 11rem)";
  }
  if (column.role === "id") {
    return "minmax(9rem, 14rem)";
  }
  if (column.role === "title") {
    return "minmax(12rem, 1fr)";
  }
  if (column.role === "subtitle") {
    return "minmax(10rem, 18rem)";
  }
  return "minmax(8rem, 14rem)";
}

function listWidthTrack(width: NonNullable<DataResourceModelColumn["listWidth"]>): string {
  if (width === "xs") return "minmax(4.5rem, max-content)";
  if (width === "sm") return "minmax(6rem, 9rem)";
  if (width === "md") return "minmax(8rem, 14rem)";
  if (width === "lg") return "minmax(12rem, 20rem)";
  if (width === "xl") return "minmax(16rem, 28rem)";
  return width;
}

function pageSizeKey(stacked: boolean): string | undefined {
  return props.pageSizeStorageKey ? `${props.pageSizeStorageKey}.${stacked ? "vertical" : "horizontal"}` : undefined;
}

function formatTime(ms: number | undefined): string {
  if (ms == null) return "-";
  return new Date(ms).toLocaleString("zh-CN");
}
</script>

<template>
  <ResponsiveSplitPane
    class="h-full min-h-0"
    :breakpoint="760"
    :default-primary-size="360"
    :default-stacked-primary-size="240"
    :min-primary-size="220"
    :min-secondary-size="220"
    :storage-key="splitStorageKey"
  >
    <template #primary="{ stacked }">
      <PagedListPane
        :key="pageSizeKey(stacked) ?? (stacked ? 'vertical' : 'horizontal')"
        :title="resource.title"
        :items="rows"
        :total="total"
        :page="page"
        :page-size="pageSize"
        :loading="loading"
        :page-size-storage-key="pageSizeKey(stacked)"
        :get-key="(row) => modelRowKey(row, resource)"
        :empty-message="emptyMessage ?? '暂无数据'"
        @update:page="emit('update:page', $event)"
        @update:page-size="emit('update:pageSize', $event)"
      >
        <template #content>
          <WorkbenchDataTable
            :rows="rows"
            :columns="tableColumns"
            :stacked="stacked"
            :selected-row-key="selectedRow ? modelRowKey(selectedRow, resource) : null"
            :get-row-key="(row) => modelRowKey(row, resource)"
            :empty-message="emptyMessage ?? '暂无数据'"
            @select-row="emit('select-row', $event)"
          >
            <template #cell="{ row, column }">
              <span :title="formatModelCell((row as Record<string, unknown>)[column.key], columns.find((item) => item.key === column.key)?.type, formatTime)">
                {{ formatModelCell((row as Record<string, unknown>)[column.key], columns.find((item) => item.key === column.key)?.type, formatTime) }}
              </span>
            </template>
          </WorkbenchDataTable>
        </template>
      </PagedListPane>
    </template>

    <template #secondary>
      <div class="scrollbar-thin h-full min-h-0 overflow-y-auto">
        <DataModelRecordDetail
          v-if="selectedRow"
          :resource="resource"
          :row="selectedRow"
          :window-id="windowId"
        />
        <div v-else class="px-4 py-6 text-center text-small text-text-subtle">选择一行数据</div>
      </div>
    </template>
  </ResponsiveSplitPane>
</template>
