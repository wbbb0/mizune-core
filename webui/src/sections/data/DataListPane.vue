<script setup lang="ts">
import { onMounted } from "vue";
import { useUiStore } from "@/stores/ui";
import { useDataSection } from "@/composables/sections/useDataSection";
import { WorkbenchListItem, WorkbenchSidebarListPane } from "@workbench-kit/vue-workbench";

const ui = useUiStore();
const { resources, selectedKey, selectResource, refreshResources, resourceBadge } = useDataSection();

onMounted(() => {
  void refreshResources();
});
</script>

<template>
  <WorkbenchSidebarListPane
    title="数据"
    :show-header="!ui.isMobile"
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
