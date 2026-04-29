<script setup lang="ts">
import { computed, onUnmounted } from "vue";
import WorkbenchActivityBar from "./WorkbenchActivityBar.vue";
import TopBar from "./TopBar.vue";
import StatusBar from "./StatusBar.vue";
import type { DesktopAreaId, WorkbenchRuntime } from "./runtime/workbenchRuntime";
import type { WorkbenchStatusbarItem, WorkbenchTopbarMenu } from "./chrome";
import type { WorkbenchNavItem } from "./navigation";
import type { WorkbenchView } from "./types";

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
const secondarySidebar = computed(() => props.view.areas.secondarySidebar);
const bottomPanel = computed(() => props.view.areas.bottomPanel);
const hasPrimarySidebar = computed(() => !!primarySidebar.value);
const hasSecondarySidebar = computed(() => !!secondarySidebar.value);
const hasBottomPanel = computed(() => !!bottomPanel.value);
const primarySidebarStyle = computed(() => props.runtime.getDesktopAreaStyle("primarySidebar"));
const primarySidebarSize = computed(() => props.runtime.getDesktopAreaSizePx("primarySidebar"));
const secondarySidebarStyle = computed(() => props.runtime.getDesktopAreaStyle("secondarySidebar"));
const secondarySidebarSize = computed(() => props.runtime.getDesktopAreaSizePx("secondarySidebar"));
const bottomPanelStyle = computed(() => props.runtime.getDesktopAreaStyle("bottomPanel"));
const bottomPanelSize = computed(() => props.runtime.getDesktopAreaSizePx("bottomPanel"));

type ResizeAxis = "x" | "y";
type ActiveResize = {
  areaId: DesktopAreaId;
  axis: ResizeAxis;
  direction: 1 | -1;
  startPointer: number;
  startSize: number;
};

let activeResize: ActiveResize | null = null;

function stopDesktopAreaResize() {
  activeResize = null;
  window.removeEventListener("pointermove", resizeDesktopArea);
  window.removeEventListener("pointerup", stopDesktopAreaResize);
  window.removeEventListener("pointercancel", stopDesktopAreaResize);
}

function resolvePointerPosition(event: PointerEvent, axis: ResizeAxis) {
  return axis === "x" ? event.clientX : event.clientY;
}

function resizeDesktopArea(event: PointerEvent) {
  if (!activeResize) {
    return;
  }
  const delta = resolvePointerPosition(event, activeResize.axis) - activeResize.startPointer;
  props.runtime.setDesktopAreaSize(
    activeResize.areaId,
    activeResize.startSize + delta * activeResize.direction
  );
}

function startDesktopAreaResize(areaId: DesktopAreaId, axis: ResizeAxis, direction: 1 | -1, event: PointerEvent) {
  if (event.button !== 0) {
    return;
  }
  event.preventDefault();
  activeResize = {
    areaId,
    axis,
    direction,
    startPointer: resolvePointerPosition(event, axis),
    startSize: props.runtime.getDesktopAreaSizePx(areaId)
  };
  window.addEventListener("pointermove", resizeDesktopArea);
  window.addEventListener("pointerup", stopDesktopAreaResize);
  window.addEventListener("pointercancel", stopDesktopAreaResize);
}

function resizeDesktopAreaBy(areaId: DesktopAreaId, deltaPx: number) {
  props.runtime.setDesktopAreaSize(areaId, props.runtime.getDesktopAreaSizePx(areaId) + deltaPx);
}

function onVerticalResizeKeydown(areaId: DesktopAreaId, direction: 1 | -1, event: KeyboardEvent) {
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    resizeDesktopAreaBy(areaId, (event.key === "ArrowRight" ? 16 : -16) * direction);
  }
}

function onHorizontalResizeKeydown(event: KeyboardEvent) {
  if (event.key === "ArrowUp") {
    event.preventDefault();
    resizeDesktopAreaBy("bottomPanel", 16);
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    resizeDesktopAreaBy("bottomPanel", -16);
  }
}

function resetDesktopAreaResize(areaId: DesktopAreaId) {
  props.runtime.resetDesktopAreaSize(areaId);
}

onUnmounted(stopDesktopAreaResize);
</script>

<template>
  <div class="relative flex h-full w-full overflow-hidden bg-surface-app text-text-primary">
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <TopBar :menus="topbarMenus" />
      <div class="flex min-h-0 flex-1 overflow-hidden">
        <WorkbenchActivityBar
          :nav-items="navItems"
          :active-nav-item-id="activeNavItemId"
          @navigate="emit('navigate', $event)"
        />
        <div
          v-if="hasPrimarySidebar"
          class="relative shrink-0 bg-surface-sidebar"
          :style="primarySidebarStyle"
        >
          <aside class="scrollbar-thin h-full overflow-x-hidden overflow-y-auto">
            <component :is="primarySidebar" />
          </aside>
          <div
            class="absolute inset-y-0 -right-0.5 z-20 w-1 cursor-col-resize bg-transparent before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-border-default hover:bg-accent/25 focus:bg-accent/25 focus:outline-none"
            role="separator"
            aria-orientation="vertical"
            :aria-valuenow="primarySidebarSize"
            tabindex="0"
            @pointerdown="startDesktopAreaResize('primarySidebar', 'x', 1, $event)"
            @dblclick="resetDesktopAreaResize('primarySidebar')"
            @keydown="onVerticalResizeKeydown('primarySidebar', 1, $event)"
          />
        </div>
        <section class="flex min-w-0 flex-1 flex-col overflow-hidden">
          <main ref="runtime.mainRegionRef" class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden pr-safe">
            <component :is="mainArea" />
          </main>
          <div
            v-if="hasBottomPanel"
            class="h-1 shrink-0 cursor-row-resize border-t border-border-default bg-surface-sidebar hover:bg-accent/25 focus:bg-accent/25 focus:outline-none"
            role="separator"
            aria-orientation="horizontal"
            :aria-valuenow="bottomPanelSize"
            tabindex="0"
            @pointerdown="startDesktopAreaResize('bottomPanel', 'y', -1, $event)"
            @dblclick="resetDesktopAreaResize('bottomPanel')"
            @keydown="onHorizontalResizeKeydown"
          />
          <aside
            v-if="hasBottomPanel"
            class="scrollbar-thin shrink-0 overflow-auto border-t border-border-default bg-surface-panel"
            :style="bottomPanelStyle"
          >
            <component :is="bottomPanel" />
          </aside>
        </section>
        <div
          v-if="hasSecondarySidebar"
          class="relative shrink-0 bg-surface-sidebar"
          :style="secondarySidebarStyle"
        >
          <div
            class="absolute inset-y-0 -left-0.5 z-20 w-1 cursor-col-resize bg-transparent before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-border-default hover:bg-accent/25 focus:bg-accent/25 focus:outline-none"
            role="separator"
            aria-orientation="vertical"
            :aria-valuenow="secondarySidebarSize"
            tabindex="0"
            @pointerdown="startDesktopAreaResize('secondarySidebar', 'x', -1, $event)"
            @dblclick="resetDesktopAreaResize('secondarySidebar')"
            @keydown="onVerticalResizeKeydown('secondarySidebar', -1, $event)"
          />
          <aside class="scrollbar-thin h-full overflow-x-hidden overflow-y-auto">
            <component :is="secondarySidebar" />
          </aside>
        </div>
      </div>
      <StatusBar :items="statusbarItems" />
    </div>
  </div>
</template>
