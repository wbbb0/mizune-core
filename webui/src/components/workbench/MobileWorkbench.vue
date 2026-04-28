<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { createStatusbarMenuNodes, type WorkbenchStatusbarItem, type WorkbenchTopbarMenu } from "./chrome";
import type { WorkbenchNavItem } from "./navigation";
import { useMenuTrigger } from "./menu/useMenuTrigger";
import type { WorkbenchRuntime } from "./runtime/workbenchRuntime";
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

const mainArea = computed(() => props.view.areas.mainArea);
const mobileHeader = computed(() => props.view.areas.mobileHeader);
const routeLabel = computed(() => props.view.title || props.navItems.find((item) => item.id === props.activeNavItemId)?.title || "");
const mobileNavItems = computed(() => props.navItems);
const mobileRootAreaId = computed(() => props.runtime.mobileRootAreaId.value);
const mobileRootArea = computed(() => props.view.areas[mobileRootAreaId.value]);
const activeMobileArea = computed(() => props.view.areas[props.runtime.activeMobileAreaId.value] ?? mainArea.value);
const hasMobileRootArea = computed(() => mobileRootAreaId.value !== "mainArea" && !!mobileRootArea.value);
const isActiveMobileAreaVisible = computed(() =>
  mobileRootAreaId.value === "mainArea" || props.runtime.activeMobileAreaId.value !== mobileRootAreaId.value
);
const isMobileOverlayVisible = computed(() => props.runtime.activeMobileAreaId.value !== mobileRootAreaId.value);
const canPopMobileArea = computed(() => props.runtime.canPopMobileArea.value);
const mobileHistoryArmed = ref(false);
const mobileHistoryStateKey = "__workbenchMobileArea";

const mobileWorkbenchTrigger = useMenuTrigger({
  baseId: "mobile-workbench-menu",
  source: "mobile-workbench",
  resolveItems: () => [
    ...props.topbarMenus.map((menu) => ({
      kind: "submenu" as const,
      id: `mobile-${menu.id}`,
      label: menu.label,
      children: menu.resolveItems()
    })),
    {
      kind: "submenu",
      id: "mobile-statusbar",
      label: "状态栏",
      children: createStatusbarMenuNodes(props.statusbarItems)
    }
  ]
});

watch(
  () => [props.view.id, props.view.layout.mobile.rootArea] as const,
  () => {
    props.runtime.resetMobileAreaStack();
    mobileHistoryArmed.value = false;
  },
  { immediate: true }
);

function pushMobileHistoryEntry() {
  if (typeof window === "undefined" || mobileHistoryArmed.value) {
    return;
  }

  const currentState = typeof window.history.state === "object" && window.history.state !== null
    ? window.history.state
    : {};
  window.history.pushState({
    ...currentState,
    [mobileHistoryStateKey]: {
      viewId: props.view.id,
      areaId: props.runtime.activeMobileAreaId.value
    }
  }, "", window.location.href);
  mobileHistoryArmed.value = true;
}

function handlePopState() {
  if (!props.runtime.canPopMobileArea.value) {
    return;
  }
  mobileHistoryArmed.value = false;
  props.runtime.popMobileArea();
}

watch(isMobileOverlayVisible, (visible) => {
  if (!visible) {
    return;
  }
  pushMobileHistoryEntry();
});

function goBack() {
  if (mobileHistoryArmed.value && typeof window !== "undefined") {
    window.history.back();
    return;
  }
  if (canPopMobileArea.value) {
    props.runtime.popMobileArea();
  } else {
    props.runtime.showRootArea();
  }
}

onMounted(() => {
  window.addEventListener("popstate", handlePopState);
});

onUnmounted(() => {
  window.removeEventListener("popstate", handlePopState);
});
</script>

<template>
  <div class="fixed inset-0 flex h-full w-full overflow-hidden bg-surface-app text-text-primary">
    <div v-if="hasMobileRootArea" class="absolute inset-0 flex flex-col bg-surface-app transition-transform duration-220 ease-[ease]">
      <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
        <header class="pt-safe flex h-[calc(44px+env(safe-area-inset-top))] shrink-0 items-center gap-2 border-b border-border-default bg-surface-sidebar px-3">
          <span class="flex-1 font-semibold text-text-secondary">{{ routeLabel }}</span>
          <nav class="flex gap-1">
            <button
              v-for="item in mobileNavItems"
              :key="item.id"
              type="button"
              class="flex h-10 w-10 items-center justify-center rounded border-0 bg-transparent text-text-muted"
              :class="{ 'text-text-secondary': activeNavItemId === item.id }"
              @click="emit('navigate', item.id)"
            >
              <component :is="item.icon" :size="20" :stroke-width="1.5" />
              <span class="sr-only">{{ item.title }}</span>
            </button>
            <button
              class="flex h-10 w-10 items-center justify-center rounded border-0 bg-transparent text-text-muted"
              type="button"
              data-menu-trigger="mobile-workbench"
              @click="mobileWorkbenchTrigger.onClick"
              @contextmenu="mobileWorkbenchTrigger.onContextMenu"
              @pointerdown="mobileWorkbenchTrigger.onPointerDown"
              @pointerup="mobileWorkbenchTrigger.onPointerUp"
              @pointercancel="mobileWorkbenchTrigger.onPointerCancel"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <circle cx="5" cy="12" r="1.5" />
                <circle cx="12" cy="12" r="1.5" />
                <circle cx="19" cy="12" r="1.5" />
              </svg>
              <span class="sr-only">工作台菜单</span>
            </button>
          </nav>
        </header>
        <component :is="mobileRootArea" />
      </div>
    </div>
    <div
      ref="runtime.mainRegionRef"
      class="absolute inset-0 z-10 flex flex-col bg-surface-app transition-transform duration-220 ease-[ease]"
      :class="isActiveMobileAreaVisible ? 'translate-x-0' : 'pointer-events-none translate-x-full'"
    >
      <header class="pt-safe flex h-[calc(44px+env(safe-area-inset-top))] shrink-0 items-center gap-2 border-b border-border-default bg-surface-sidebar px-3">
        <button v-if="canPopMobileArea" class="flex cursor-pointer items-center gap-1 border-0 bg-transparent px-0 py-1 text-ui text-accent" @click="goBack">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <span>返回</span>
        </button>
        <component :is="mobileHeader" v-if="view.areas.mobileHeader" />
      </header>
      <div class="min-h-0 flex-1 overflow-hidden">
        <component :is="activeMobileArea" />
      </div>
    </div>
  </div>
</template>
