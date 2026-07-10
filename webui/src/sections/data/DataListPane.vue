<script setup lang="ts">
import { onMounted } from "vue";
import { useDataSection } from "@/composables/sections/useDataSection";
import { WorkbenchListItem, WorkbenchSidebarListPane, useWorkbenchViewport } from "@workbench-kit/vue";

const { isMobile } = useWorkbenchViewport();
const { resources, selectedKey, selectResource, refreshResources, resourceBadge } = useDataSection();

onMounted(() => {
  void refreshResources();
});
</script>

<template>
  <WorkbenchSidebarListPane
    title="数据"
    :show-header="!isMobile"
    :items="resources"
    empty-message="暂无数据资源"
    :item-key="(entry) => entry.id"
  >
    <template #item="{ item: entry }">
      <WorkbenchListItem
        :selected="selectedKey === entry.id"
        :title="entry.title"
        :meta="resourceBadge(entry)"
        @select="selectResource(entry.id)"
      >
      </WorkbenchListItem>
    </template>
  </WorkbenchSidebarListPane>
</template>
