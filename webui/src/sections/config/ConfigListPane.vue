<script setup lang="ts">
import { onMounted } from "vue";
import { useUiStore } from "@/stores/ui";
import { useConfigSection } from "@/composables/sections/useConfigSection";
import { WorkbenchListItem, WorkbenchSidebarListPane } from "@workbench-kit/vue-workbench";

const ui = useUiStore();
const { resources, selectedKey, selectResource, refreshResources } = useConfigSection();

onMounted(() => {
  void refreshResources();
});
</script>

<template>
  <WorkbenchSidebarListPane
    title="配置编辑器"
    :show-header="!ui.isMobile"
    :items="resources"
    empty-message="暂无可编辑资源"
    :item-key="(resource) => resource.key"
  >
    <template #item="{ item: resource }">
      <WorkbenchListItem
        :selected="selectedKey === resource.key"
        :title="resource.title"
        :meta="resource.kind"
        @select="selectResource(resource.key)"
      >
      </WorkbenchListItem>
    </template>
  </WorkbenchSidebarListPane>
</template>
