<script setup lang="ts">
import { computed } from "vue";
import ActivityBar from "@/components/layout/ActivityBar.vue";
import TopBar from "@/components/workbench/TopBar.vue";
import StatusBar from "@/components/workbench/StatusBar.vue";
import type { WorkbenchRuntime } from "@/components/workbench/runtime/workbenchRuntime";
import type { WorkbenchStatusbarItem, WorkbenchTopbarMenu } from "@/components/workbench/chrome";
import type { WorkbenchSection } from "@/components/workbench/types";

const props = defineProps<{
  runtime: WorkbenchRuntime;
  section: WorkbenchSection;
  topbarMenus: WorkbenchTopbarMenu[];
  statusbarItems: WorkbenchStatusbarItem[];
}>();

const listPane = computed(() => props.section.regions.listPane);
const mainPane = computed(() => props.section.regions.mainPane);
</script>

<template>
  <div class="relative flex h-full w-full overflow-hidden bg-surface-app text-text-primary">
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <TopBar :menus="topbarMenus" />
      <div class="flex min-h-0 flex-1 overflow-hidden">
        <ActivityBar />
        <aside class="scrollbar-thin w-(--side-panel-width) shrink-0 overflow-x-hidden overflow-y-auto border-r border-border-default bg-surface-sidebar">
          <component :is="listPane" v-if="section.regions.listPane" />
        </aside>
        <main ref="runtime.mainRegionRef" class="flex min-w-0 flex-1 flex-col overflow-hidden pr-safe">
          <component :is="mainPane" />
        </main>
      </div>
      <StatusBar :items="statusbarItems" />
    </div>
  </div>
</template>
