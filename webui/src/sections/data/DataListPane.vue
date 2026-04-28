<script setup lang="ts">
import { onMounted } from "vue";
import { useUiStore } from "@/stores/ui";
import { useDataSection } from "@/composables/sections/useDataSection";
import { WorkbenchAreaHeader, WorkbenchEmptyState, WorkbenchListItem } from "@/components/workbench/primitives";

const ui = useUiStore();
const { resources, selectedKey, selectResource, refreshResources, resourceBadge } = useDataSection();

onMounted(() => {
  void refreshResources();
});
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <WorkbenchAreaHeader v-if="!ui.isMobile" title="数据" />
    <div class="min-h-0 flex-1 overflow-y-auto">
      <WorkbenchListItem
        v-for="entry in resources"
        :key="entry.key"
        :selected="selectedKey === entry.key"
        :title="entry.title"
        :meta="resourceBadge(entry)"
        @select="selectResource(entry.key)"
      >
      </WorkbenchListItem>
      <WorkbenchEmptyState v-if="resources.length === 0" :centered="false" class="justify-center px-3 py-6 text-center text-small text-text-subtle" message="暂无数据资源" />
    </div>
  </div>
</template>
