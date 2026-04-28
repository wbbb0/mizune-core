<script setup lang="ts">
import { onMounted } from "vue";
import { useUiStore } from "@/stores/ui";
import { useConfigSection } from "@/composables/sections/useConfigSection";
import { WorkbenchAreaHeader, WorkbenchEmptyState, WorkbenchListItem } from "@/components/workbench/primitives";

const ui = useUiStore();
const { resources, selectedKey, selectResource, refreshResources } = useConfigSection();

onMounted(() => {
  void refreshResources();
});
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <WorkbenchAreaHeader v-if="!ui.isMobile" title="配置编辑器" />
    <div class="min-h-0 flex-1 overflow-y-auto">
      <WorkbenchListItem
        v-for="resource in resources"
        :key="resource.key"
        :selected="selectedKey === resource.key"
        :title="resource.title"
        :meta="resource.kind"
        @select="selectResource(resource.key)"
      >
      </WorkbenchListItem>
      <WorkbenchEmptyState v-if="resources.length === 0" :centered="false" class="justify-center px-3 py-6 text-center text-small text-text-subtle" message="暂无可编辑资源" />
    </div>
  </div>
</template>
