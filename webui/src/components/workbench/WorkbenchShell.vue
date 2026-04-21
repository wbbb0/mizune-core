<script setup lang="ts">
import { computed, watch } from "vue";
import DesktopWorkbench from "@/components/workbench/DesktopWorkbench.vue";
import MobileWorkbench from "@/components/workbench/MobileWorkbench.vue";
import MenuHost from "@/components/workbench/menu/MenuHost.vue";
import WindowHost from "@/components/workbench/windows/WindowHost.vue";
import { useMenuRuntime } from "@/composables/workbench/menu/useMenuRuntime";
import { useWorkbenchWindows } from "@/composables/workbench/useWorkbenchWindows";
import { useUiStore } from "@/stores/ui";
import type { WorkbenchStatusbarItem, WorkbenchTopbarMenu } from "@/components/workbench/chrome";
import type { WorkbenchSection } from "@/components/workbench/types";

defineProps<{
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

watch(activeModalWindowId, (windowId) => {
  if (windowId) {
    closeAllMenus();
  }
});
</script>

<template>
  <DesktopWorkbench v-if="!ui.isMobile" :section="section" :topbar-menus="topbarMenus" :statusbar-items="statusbarItems" />
  <MobileWorkbench v-else :section="section" :topbar-menus="topbarMenus" :statusbar-items="statusbarItems" />
  <MenuHost />
  <WindowHost />
</template>
