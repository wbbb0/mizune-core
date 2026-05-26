<script setup lang="ts" generic="TItem">
import WorkbenchAreaHeader from "./WorkbenchAreaHeader.vue";
import WorkbenchEmptyState from "./WorkbenchEmptyState.vue";

withDefaults(defineProps<{
  title?: string;
  items: readonly TItem[];
  loading?: boolean;
  emptyMessage?: string;
  showHeader?: boolean;
  itemKey?: (item: TItem, index: number) => string | number;
}>(), {
  title: "",
  loading: false,
  emptyMessage: "暂无数据",
  showHeader: true,
  itemKey: undefined
});

function getItemKey(item: TItem, index: number): string | number {
  return typeof item === "object" && item !== null && "id" in item && typeof item.id === "string"
    ? item.id
    : index;
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col overflow-hidden">
    <WorkbenchAreaHeader v-if="showHeader" :title="title">
      <slot name="header" />
      <template v-if="$slots.actions" #actions>
        <slot name="actions" />
      </template>
    </WorkbenchAreaHeader>
    <div class="min-h-0 flex-1 overflow-y-auto">
      <slot name="before-list" />
      <template v-for="(item, index) in items" :key="itemKey ? itemKey(item, index) : getItemKey(item, index)">
        <slot name="item" :item="item" :index="index" />
      </template>
      <WorkbenchEmptyState
        v-if="items.length === 0 && !loading"
        :centered="false"
        class="justify-center px-3 py-6 text-center text-small text-text-subtle"
        :message="emptyMessage"
      />
      <slot name="after-list" />
    </div>
  </div>
</template>
