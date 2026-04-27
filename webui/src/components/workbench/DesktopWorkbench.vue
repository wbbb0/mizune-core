<script setup lang="ts">
import { computed, onUnmounted } from "vue";
import ActivityBar from "@/components/layout/ActivityBar.vue";
import TopBar from "@/components/workbench/TopBar.vue";
import StatusBar from "@/components/workbench/StatusBar.vue";
import type { WorkbenchRuntime } from "@/components/workbench/runtime/workbenchRuntime";
import type { WorkbenchStatusbarItem, WorkbenchTopbarMenu } from "@/components/workbench/chrome";
import type { WorkbenchNavItem } from "@/components/workbench/navigation";
import type { WorkbenchSection } from "@/components/workbench/types";

const props = defineProps<{
  runtime: WorkbenchRuntime;
  section: WorkbenchSection;
  navItems: readonly WorkbenchNavItem[];
  activeNavItemId: string;
  topbarMenus: WorkbenchTopbarMenu[];
  statusbarItems: WorkbenchStatusbarItem[];
}>();

const emit = defineEmits<{
  navigate: [itemId: string];
}>();

const listPane = computed(() => props.section.regions.listPane);
const mainPane = computed(() => props.section.regions.mainPane);
const hasListPane = computed(() => !!listPane.value);
const listPaneStyle = computed(() => props.runtime.getDesktopPaneStyle("list"));
const listPaneWidth = computed(() => props.runtime.getDesktopPaneWidthPx("list"));
let resizeStartX = 0;
let resizeStartWidth = 0;

function stopListPaneResize() {
  window.removeEventListener("pointermove", resizeListPane);
  window.removeEventListener("pointerup", stopListPaneResize);
  window.removeEventListener("pointercancel", stopListPaneResize);
}

function resizeListPane(event: PointerEvent) {
  props.runtime.setDesktopPaneWidth("list", resizeStartWidth + event.clientX - resizeStartX);
}

function startListPaneResize(event: PointerEvent) {
  if (event.button !== 0) {
    return;
  }
  event.preventDefault();
  resizeStartX = event.clientX;
  resizeStartWidth = props.runtime.getDesktopPaneWidthPx("list");
  window.addEventListener("pointermove", resizeListPane);
  window.addEventListener("pointerup", stopListPaneResize);
  window.addEventListener("pointercancel", stopListPaneResize);
}

function onListPaneResizeKeydown(event: KeyboardEvent) {
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    props.runtime.setDesktopPaneWidth("list", props.runtime.getDesktopPaneWidthPx("list") - 16);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    props.runtime.setDesktopPaneWidth("list", props.runtime.getDesktopPaneWidthPx("list") + 16);
  }
}

function resetListPaneResize() {
  props.runtime.resetDesktopPaneWidth("list");
}

onUnmounted(stopListPaneResize);
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
        <aside v-if="hasListPane" class="scrollbar-thin shrink-0 overflow-x-hidden overflow-y-auto bg-surface-sidebar" :style="listPaneStyle">
          <component :is="listPane" />
        </aside>
        <div
          v-if="hasListPane"
          class="relative w-1 shrink-0 cursor-col-resize border-l border-border-default bg-surface-sidebar hover:bg-accent/25 focus:bg-accent/25 focus:outline-none"
          role="separator"
          aria-orientation="vertical"
          :aria-valuenow="listPaneWidth"
          tabindex="0"
          @pointerdown="startListPaneResize"
          @dblclick="resetListPaneResize"
          @keydown="onListPaneResizeKeydown"
        />
        <main ref="runtime.mainRegionRef" class="flex min-w-0 flex-1 flex-col overflow-hidden pr-safe">
          <component :is="mainPane" />
        </main>
      </div>
      <StatusBar :items="statusbarItems" />
    </div>
  </div>
</template>
