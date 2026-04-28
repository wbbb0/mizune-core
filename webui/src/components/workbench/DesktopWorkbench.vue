<script setup lang="ts">
import { computed, onUnmounted } from "vue";
import ActivityBar from "@/components/layout/ActivityBar.vue";
import TopBar from "@/components/workbench/TopBar.vue";
import StatusBar from "@/components/workbench/StatusBar.vue";
import type { WorkbenchRuntime } from "@/components/workbench/runtime/workbenchRuntime";
import type { WorkbenchStatusbarItem, WorkbenchTopbarMenu } from "@/components/workbench/chrome";
import type { WorkbenchNavItem } from "@/components/workbench/navigation";
import type { WorkbenchView } from "@/components/workbench/types";

const props = defineProps<{
  runtime: WorkbenchRuntime;
  view: WorkbenchView;
  navItems: readonly WorkbenchNavItem[];
  activeNavItemId: string;
  topbarMenus: WorkbenchTopbarMenu[];
  statusbarItems: WorkbenchStatusbarItem[];
}>();

const emit = defineEmits<{
  navigate: [itemId: string];
}>();

const primarySidebar = computed(() => props.view.areas.primarySidebar);
const mainArea = computed(() => props.view.areas.mainArea);
const hasPrimarySidebar = computed(() => !!primarySidebar.value);
const primarySidebarStyle = computed(() => props.runtime.getDesktopAreaStyle("primarySidebar"));
const primarySidebarWidth = computed(() => props.runtime.getDesktopAreaWidthPx("primarySidebar"));
let resizeStartX = 0;
let resizeStartWidth = 0;

function stopPrimarySidebarResize() {
  window.removeEventListener("pointermove", resizePrimarySidebar);
  window.removeEventListener("pointerup", stopPrimarySidebarResize);
  window.removeEventListener("pointercancel", stopPrimarySidebarResize);
}

function resizePrimarySidebar(event: PointerEvent) {
  props.runtime.setDesktopAreaWidth("primarySidebar", resizeStartWidth + event.clientX - resizeStartX);
}

function startPrimarySidebarResize(event: PointerEvent) {
  if (event.button !== 0) {
    return;
  }
  event.preventDefault();
  resizeStartX = event.clientX;
  resizeStartWidth = props.runtime.getDesktopAreaWidthPx("primarySidebar");
  window.addEventListener("pointermove", resizePrimarySidebar);
  window.addEventListener("pointerup", stopPrimarySidebarResize);
  window.addEventListener("pointercancel", stopPrimarySidebarResize);
}

function onPrimarySidebarResizeKeydown(event: KeyboardEvent) {
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    props.runtime.setDesktopAreaWidth("primarySidebar", props.runtime.getDesktopAreaWidthPx("primarySidebar") - 16);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    props.runtime.setDesktopAreaWidth("primarySidebar", props.runtime.getDesktopAreaWidthPx("primarySidebar") + 16);
  }
}

function resetPrimarySidebarResize() {
  props.runtime.resetDesktopAreaWidth("primarySidebar");
}

onUnmounted(stopPrimarySidebarResize);
</script>

<template>
  <div class="relative flex h-full w-full overflow-hidden bg-surface-app text-text-primary">
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <TopBar :menus="topbarMenus" />
      <div class="flex min-h-0 flex-1 overflow-hidden">
        <ActivityBar
          :nav-items="navItems"
          :active-nav-item-id="activeNavItemId"
          @navigate="emit('navigate', $event)"
        />
        <aside v-if="hasPrimarySidebar" class="scrollbar-thin shrink-0 overflow-x-hidden overflow-y-auto bg-surface-sidebar" :style="primarySidebarStyle">
          <component :is="primarySidebar" />
        </aside>
        <div
          v-if="hasPrimarySidebar"
          class="relative w-1 shrink-0 cursor-col-resize border-l border-border-default bg-surface-sidebar hover:bg-accent/25 focus:bg-accent/25 focus:outline-none"
          role="separator"
          aria-orientation="vertical"
          :aria-valuenow="primarySidebarWidth"
          tabindex="0"
          @pointerdown="startPrimarySidebarResize"
          @dblclick="resetPrimarySidebarResize"
          @keydown="onPrimarySidebarResizeKeydown"
        />
        <main ref="runtime.mainRegionRef" class="flex min-w-0 flex-1 flex-col overflow-hidden pr-safe">
          <component :is="mainArea" />
        </main>
      </div>
      <StatusBar :items="statusbarItems" />
    </div>
  </div>
</template>
