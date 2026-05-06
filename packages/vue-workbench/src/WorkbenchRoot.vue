<script setup lang="ts">
import { computed, onUnmounted, watch } from "vue";
import WorkbenchShell from "./WorkbenchShell.vue";
import MenuHost from "./menu/MenuHost.vue";
import ToastViewport from "./toasts/ToastViewport.vue";
import WindowHost from "./windows/WindowHost.vue";
import { activateWorkbenchController, createWorkbenchController, provideWorkbenchController } from "./runtime/workbenchController";
import type { WorkbenchStatusbarItem, WorkbenchTopbarMenu } from "./chrome";
import type { WorkbenchNavItem } from "./navigation";
import type { WorkbenchView } from "./types";

const props = defineProps<{
  view: WorkbenchView;
  navItems: readonly WorkbenchNavItem[];
  activeNavItemId: string;
  topbarMenus: WorkbenchTopbarMenu[];
  statusbarItems: WorkbenchStatusbarItem[];
  isMobile: boolean;
}>();

const emit = defineEmits<{
  navigate: [itemId: string];
}>();

const controller = createWorkbenchController(computed(() => props.view));
provideWorkbenchController(controller);

const { closeAllMenus } = controller.menu;
const { desktopWindows, mobileWindows } = controller.windows;
const runtime = controller.runtime;
const renderedWindows = computed(() => (props.isMobile ? mobileWindows.value : desktopWindows.value));
const activeModalWindowId = computed(() => (
  [...renderedWindows.value].reverse().find((window) => window.definition.modal)?.id ?? null
));
const deactivateController = activateWorkbenchController(controller);

watch(activeModalWindowId, (windowId) => {
  if (windowId) {
    closeAllMenus();
  }
});

onUnmounted(deactivateController);
</script>

<template>
  <WorkbenchShell
    :runtime="runtime"
    :view="view"
    :nav-items="navItems"
    :active-nav-item-id="activeNavItemId"
    :topbar-menus="topbarMenus"
    :statusbar-items="statusbarItems"
    :is-mobile="isMobile"
    @navigate="emit('navigate', $event)"
  />
  <MenuHost />
  <ToastViewport />
  <WindowHost :is-mobile="isMobile" />
</template>
