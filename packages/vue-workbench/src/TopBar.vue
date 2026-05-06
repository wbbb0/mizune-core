<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { WorkbenchTopbarMenu } from "./chrome";
import { useMenuRuntime } from "./menu/useMenuRuntime";

const props = defineProps<{
  menus: WorkbenchTopbarMenu[];
}>();

const { openMenu } = useMenuRuntime();
const overlayRect = ref<DOMRect | null>(null);

type WindowControlsOverlayApi = {
  visible: boolean;
  getTitlebarAreaRect: () => DOMRect;
  addEventListener: (type: "geometrychange", listener: () => void) => void;
  removeEventListener: (type: "geometrychange", listener: () => void) => void;
};

function getWindowControlsOverlay(): WindowControlsOverlayApi | null {
  if (typeof navigator === "undefined" || !("windowControlsOverlay" in navigator)) {
    return null;
  }

  return (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlayApi }).windowControlsOverlay ?? null;
}

function syncWindowControlsOverlay() {
  const windowControlsOverlay = getWindowControlsOverlay();
  if (!windowControlsOverlay?.visible) {
    overlayRect.value = null;
    return;
  }

  overlayRect.value = windowControlsOverlay.getTitlebarAreaRect();
}

const overlayPaddingStyle = computed(() => {
  if (!overlayRect.value || typeof window === "undefined") {
    return undefined;
  }

  const leftInset = Math.max(12, overlayRect.value.x + 8);
  const rightInset = Math.max(12, window.innerWidth - overlayRect.value.right + 8);
  const minHeight = Math.max(36, overlayRect.value.height);

  return {
    paddingLeft: `${leftInset}px`,
    paddingRight: `${rightInset}px`,
    minHeight: `calc(${minHeight}px + env(safe-area-inset-top))`
  };
});

function openTopbarMenu(menu: WorkbenchTopbarMenu, event: MouseEvent) {
  openMenu({
    id: `desktop-topbar-menu:${menu.id}`,
    source: "topbar",
    anchor: { element: event.currentTarget as HTMLElement | null },
    items: menu.resolveItems()
  });
}

onMounted(() => {
  const windowControlsOverlay = getWindowControlsOverlay();
  if (!windowControlsOverlay) {
    return;
  }

  syncWindowControlsOverlay();
  windowControlsOverlay.addEventListener("geometrychange", syncWindowControlsOverlay);
  window.addEventListener("resize", syncWindowControlsOverlay, { passive: true });
});

onBeforeUnmount(() => {
  const windowControlsOverlay = getWindowControlsOverlay();
  if (!windowControlsOverlay) {
    return;
  }

  windowControlsOverlay.removeEventListener("geometrychange", syncWindowControlsOverlay);
  window.removeEventListener("resize", syncWindowControlsOverlay);
});
</script>

<template>
  <header
    class="pt-safe flex h-[calc(34px+env(safe-area-inset-top))] shrink-0 items-center gap-1.5 border-b border-border-default bg-surface-sidebar px-3"
    :style="overlayPaddingStyle"
  >
    <button
      v-for="menu in props.menus"
      :key="menu.id"
      class="rounded-md px-2 py-0.5 text-[13px] text-text-muted transition-colors duration-120 hover:bg-surface-hover hover:text-text-primary focus-visible:bg-surface-hover focus-visible:text-text-primary"
      :data-menu-trigger="`topbar:${menu.id}`"
      @click="openTopbarMenu(menu, $event)"
    >
      {{ menu.label }}
    </button>
    <div class="min-w-0 flex-1" />
  </header>
</template>
