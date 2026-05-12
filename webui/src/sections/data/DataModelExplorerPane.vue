<script setup lang="ts">
import { computed } from "vue";
import type { DataResource, DataResourceModelColumn } from "@/api/data";
import { PagedListPane, ResponsiveSplitPane } from "@workbench-kit/vue-workbench";
import DataModelRecordDetail from "./DataModelRecordDetail.vue";
import { formatModelCell, getModelListColumns, modelRowId, modelRowKey } from "./dataModelView";

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
const gridStyle = computed(() => ({
  gridTemplateColumns: columns.value.length
    ? columns.value.map((column) => columnGridTrack(column)).join(" ")
    : "minmax(7rem, 1fr)"
}));

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
        <template #header>
          <div v-if="!stacked" class="grid min-w-full w-max border-b border-border-default bg-surface-muted px-4 py-2 font-mono text-small text-text-subtle" :style="gridStyle">
            <span v-for="column in columns" :key="column.key" class="truncate">{{ column.title || column.key }}</span>
          </div>
        </template>
        <template #item="{ item: row }">
          <button
            class="min-w-full w-max border-b border-border-subtle px-4 py-2 text-left text-small hover:bg-surface-hover"
            :class="[
              stacked ? 'flex min-h-16 flex-col gap-1' : 'grid min-h-12',
              { 'bg-surface-selected': selectedRow && modelRowId(selectedRow, resource) === modelRowId(row, resource) }
            ]"
            :style="stacked ? undefined : gridStyle"
            @click="emit('select-row', row)"
          >
            <span
              v-for="column in columns"
              :key="column.key"
              class="min-w-0 truncate"
              :class="column.role === 'title' ? 'font-medium text-text-secondary' : 'font-mono text-text-muted'"
              :title="formatModelCell((row as Record<string, unknown>)[column.key], column.type, formatTime)"
            >
              <span v-if="stacked" class="mr-1 font-sans text-text-subtle">{{ column.title || column.key }}</span>
              <span>{{ formatModelCell((row as Record<string, unknown>)[column.key], column.type, formatTime) }}</span>
            </span>
          </button>
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
