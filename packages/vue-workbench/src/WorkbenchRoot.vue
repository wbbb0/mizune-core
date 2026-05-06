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

/** WorkbenchRoot 的 public props。业务项目通常只需要挂载这一层组件。 */
type WorkbenchRootProps = {
  /** 当前激活的业务 view。 */
  view: WorkbenchView;
  /** Activity bar 导航项，导航行为通过 navigate 事件交给业务项目处理。 */
  navItems: readonly WorkbenchNavItem[];
  /** 当前高亮导航项 ID。 */
  activeNavItemId: string;
  /** 顶部菜单定义。 */
  topbarMenus: WorkbenchTopbarMenu[];
  /** 状态栏组件项。 */
  statusbarItems: WorkbenchStatusbarItem[];
  /** 是否使用移动端布局。媒体查询或 store 由业务项目维护。 */
  isMobile: boolean;
};

const props = defineProps<WorkbenchRootProps>();

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
