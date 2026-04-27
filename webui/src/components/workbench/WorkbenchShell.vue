<script setup lang="ts">
import { computed, onUnmounted, watch } from "vue";
import DesktopWorkbench from "@/components/workbench/DesktopWorkbench.vue";
import MobileWorkbench from "@/components/workbench/MobileWorkbench.vue";
import MenuHost from "@/components/workbench/menu/MenuHost.vue";
import WindowHost from "@/components/workbench/windows/WindowHost.vue";
import { useMenuRuntime } from "@/composables/workbench/menu/useMenuRuntime";
import { useWorkbenchWindows } from "@/composables/workbench/useWorkbenchWindows";
import { useUiStore } from "@/stores/ui";
import { activateWorkbenchRuntime, createWorkbenchRuntime, provideWorkbenchRuntime } from "@/components/workbench/runtime/workbenchRuntime";
import type { WorkbenchStatusbarItem, WorkbenchTopbarMenu } from "@/components/workbench/chrome";
import type { WorkbenchSection } from "@/components/workbench/types";

const props = defineProps<{
  section: WorkbenchSection;
  topbarMenus: WorkbenchTopbarMenu[];
  statusbarItems: WorkbenchStatusbarItem[];
}>();

const ui = useUiStore();
const { closeAllMenus } = useMenuRuntime();
const { desktopWindows, mobileWindows } = useWorkbenchWindows();

const renderedWindows = computed(() => (ui.isMobile ? mobileWindows.value : desktopWindows.value));
const activeModalWindowId = computed(() => (
  [...renderedWindows.value].reverse().find((window) => window.definition.modal)?.id ?? null
));
const runtime = createWorkbenchRuntime(computed(() => props.section));
provideWorkbenchRuntime(runtime);
const deactivateRuntime = activateWorkbenchRuntime(runtime);
onUnmounted(deactivateRuntime);

watch(activeModalWindowId, (windowId) => {
  if (windowId) {
    closeAllMenus();
  }
});
</script>

<template>
  <DesktopWorkbench v-if="!ui.isMobile" :runtime="runtime" :section="section" :topbar-menus="topbarMenus" :statusbar-items="statusbarItems" />
  <MobileWorkbench v-else :runtime="runtime" :section="section" :topbar-menus="topbarMenus" :statusbar-items="statusbarItems" />
  <MenuHost />
  <WindowHost />
</template>
