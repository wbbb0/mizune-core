<script setup lang="ts" generic="TRow">
import { computed } from "vue";
import WorkbenchEmptyState from "./WorkbenchEmptyState.vue";
import type { WorkbenchDataTableColumn } from "./dataTableTypes";

const props = withDefaults(defineProps<{
  rows: readonly TRow[];
  columns: readonly WorkbenchDataTableColumn<TRow>[];
  getRowKey?: (row: TRow, index: number) => string | number;
  selectedRowKey?: string | number | null;
  stacked?: boolean;
  emptyMessage?: string;
}>(), {
  getRowKey: undefined,
  selectedRowKey: null,
  stacked: false,
  emptyMessage: "暂无数据"
});

const emit = defineEmits<{
  "select-row": [row: TRow];
}>();

const gridStyle = computed(() => ({
  gridTemplateColumns: props.columns.length
    ? props.columns.map((column) => column.width || "minmax(8rem, 1fr)").join(" ")
    : "minmax(7rem, 1fr)"
}));

function rowKey(row: TRow, index: number): string | number {
  return props.getRowKey?.(row, index) ?? index;
}

function cellClass(row: TRow, column: WorkbenchDataTableColumn<TRow>) {
  const resolved = typeof column.cellClass === "function" ? column.cellClass(row, column) : column.cellClass;
  return [column.class, resolved].filter(Boolean).join(" ");
}
</script>

<template>
  <div class="scrollbar-thin min-h-0 flex-1 overflow-auto">
    <div
      v-if="!stacked && columns.length"
      class="grid min-w-full w-max border-b border-border-default bg-surface-muted px-4 py-2 font-mono text-small text-text-subtle"
      :style="gridStyle"
    >
      <span
        v-for="column in columns"
        :key="column.key"
        class="truncate"
        :class="[column.class, column.headerClass]"
      >
        {{ column.title || column.key }}
      </span>
    </div>

    <template v-for="(row, index) in rows" :key="rowKey(row, index)">
      <button
        class="min-w-full w-max border-b border-border-subtle px-4 py-2 text-left text-small hover:bg-surface-hover"
        :class="[
          stacked ? 'flex min-h-16 flex-col gap-1' : 'grid min-h-12',
          { 'bg-surface-selected': selectedRowKey !== null && rowKey(row, index) === selectedRowKey }
        ]"
        :style="stacked ? undefined : gridStyle"
        @click="emit('select-row', row)"
      >
        <span
          v-for="column in columns"
          :key="column.key"
          class="min-w-0 truncate"
          :class="cellClass(row, column)"
        >
          <span v-if="stacked" class="mr-1 font-sans text-text-subtle">{{ column.title || column.key }}</span>
          <slot name="cell" :row="row" :column="column">
            {{ row && typeof row === "object" ? String((row as Record<string, unknown>)[column.key] ?? "") : "" }}
          </slot>
        </span>
      </button>
    </template>

    <WorkbenchEmptyState
      v-if="rows.length === 0"
      class="justify-center px-3 py-6 text-center text-small text-text-subtle"
      :message="emptyMessage"
    />
  </div>
</template>
