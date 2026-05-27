<script setup lang="ts">
import { computed } from "vue";
import { WorkbenchAreaHeader, WorkbenchEmptyState } from "@workbench-kit/vue";
import { useDataSection } from "@/composables/sections/useDataSection";
import DataModelRecordDetail from "./DataModelRecordDetail.vue";
import { rowText } from "./dataModelView";

const {
  resource,
  selectedRegistryRow
} = useDataSection();

const title = computed(() => {
  const row = selectedRegistryRow.value;
  const model = resource.value?.model;
  if (!row || !model) return "";
  const titleColumn = model.list?.titleColumn;
  const fallbackColumn = model.list?.fallbackTitleColumn ?? model.primaryKey[0];
  const raw = titleColumn ? row[titleColumn] : null;
  return rowText(raw) !== "-" ? rowText(raw) : rowText(fallbackColumn ? row[fallbackColumn] : "");
});
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <WorkbenchEmptyState v-if="!resource?.model" message="选择一个 model-driven 数据资源" />
    <WorkbenchEmptyState v-else-if="!selectedRegistryRow" message="选择一行数据" />
    <template v-else>
      <WorkbenchAreaHeader class="gap-2 overflow-hidden px-4" :uppercase="false">
        <div class="min-w-0 flex-1">
          <div class="truncate text-small font-medium text-text-secondary">{{ title }}</div>
          <div class="truncate font-mono text-small text-text-subtle">{{ resource.title }}</div>
        </div>
      </WorkbenchAreaHeader>

      <div class="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <DataModelRecordDetail
          :resource="resource"
          :row="selectedRegistryRow"
        />
      </div>
    </template>
  </div>
</template>
