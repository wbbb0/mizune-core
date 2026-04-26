<script setup lang="ts">
import { computed, watch } from "vue";
import { useRoute } from "vue-router";
import { createStatusbarMenuNodes, type WorkbenchStatusbarItem, type WorkbenchTopbarMenu } from "@/components/workbench/chrome";
import { workbenchNavItems } from "@/components/workbench/navigation";
import { useMenuTrigger } from "@/composables/workbench/menu/useMenuTrigger";
import type { WorkbenchRuntime } from "@/components/workbench/runtime/workbenchRuntime";
import type { WorkbenchSection } from "@/components/workbench/types";

const props = defineProps<{
  runtime: WorkbenchRuntime;
  section: WorkbenchSection;
  topbarMenus: WorkbenchTopbarMenu[];
  statusbarItems: WorkbenchStatusbarItem[];
}>();

const route = useRoute();

const listPane = computed(() => props.section.regions.listPane);
const mainPane = computed(() => props.section.regions.mainPane);
const mobileHeader = computed(() => props.section.regions.mobileHeader);
const routeLabel = computed(() => props.section.title || workbenchNavItems.find((item) => item.id === route.name)?.title || "");
const mobileNavItems = workbenchNavItems;
const isMobileMainVisible = computed(() => props.runtime.isMobileMainVisible.value);

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
  () => [props.section.id, props.section.layout.mobileMainFlow] as const,
  () => {
    props.runtime.resetMobileStack();
  },
  { immediate: true }
);

function goBack() {
  if (!props.runtime.popMobileRegion()) {
    props.runtime.showList();
  }
}
</script>

<template>
  <div class="fixed inset-0 flex h-full w-full overflow-hidden bg-surface-app text-text-primary">
    <div class="absolute inset-0 flex flex-col bg-surface-app transition-transform duration-220 ease-[ease]">
      <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
        <header class="pt-safe flex h-[calc(44px+env(safe-area-inset-top))] shrink-0 items-center gap-2 border-b border-border-default bg-surface-sidebar px-3">
          <span class="flex-1 font-semibold text-text-secondary">{{ routeLabel }}</span>
          <nav class="flex gap-1">
            <router-link
              v-for="item in mobileNavItems"
              :key="item.id"
              :to="item.path"
              class="flex h-10 w-10 items-center justify-center rounded text-text-muted no-underline"
              :class="{ 'text-text-secondary': route.name === item.id }"
            >
              <component :is="item.icon" :size="20" :stroke-width="1.5" />
              <span class="sr-only">{{ item.title }}</span>
            </router-link>
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
        <component :is="listPane" v-if="section.regions.listPane" />
      </div>
    </div>
    <div
      ref="runtime.mainRegionRef"
      class="absolute inset-0 z-10 flex flex-col bg-surface-app transition-transform duration-220 ease-[ease]"
      :class="isMobileMainVisible ? 'translate-x-0' : 'pointer-events-none translate-x-full'"
    >
      <header class="pt-safe flex h-[calc(44px+env(safe-area-inset-top))] shrink-0 items-center gap-2 border-b border-border-default bg-surface-sidebar px-3">
        <button class="flex cursor-pointer items-center gap-1 border-0 bg-transparent px-0 py-1 text-ui text-accent" @click="goBack">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <span>返回</span>
        </button>
        <component :is="mobileHeader" v-if="section.regions.mobileHeader" />
      </header>
      <div class="min-h-0 flex-1 overflow-hidden">
        <component :is="mainPane" />
      </div>
    </div>
  </div>
</template>
