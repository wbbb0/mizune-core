<script setup lang="ts">
import { computed, watch } from "vue";
import { useRoute } from "vue-router";
import ActivityBar from "@/components/layout/ActivityBar.vue";
import { workbenchNavItems } from "@/components/workbench/navigation";
import { useUiStore } from "@/stores/ui";
import { useWorkbenchRuntime } from "@/composables/workbench/useWorkbenchRuntime";
import type { WorkbenchSection } from "@/components/workbench/types";

const props = defineProps<{
  section: WorkbenchSection;
}>();

const ui = useUiStore();
const route = useRoute();
const { mobileScreen, showList, showMain } = useWorkbenchRuntime();

const listPane = computed(() => props.section.regions.listPane);
const mainPane = computed(() => props.section.regions.mainPane);
const mobileHeader = computed(() => props.section.regions.mobileHeader);
const routeLabel = computed(() => props.section.title || workbenchNavItems.find((item) => item.id === route.name)?.title || "");
const mobileNavItems = workbenchNavItems;

watch(
  () => props.section.layout.mobileMainFlow,
  (mobileMainFlow) => {
    if (mobileMainFlow === "main-only") {
      showMain();
      return;
    }

    showList();
  },
  { immediate: true }
);
</script>

<template>
  <div
    class="flex h-full w-full overflow-hidden bg-surface-app text-text-primary"
    :class="ui.isMobile ? 'fixed inset-0' : 'relative pt-safe'"
  >
    <template v-if="!ui.isMobile">
      <ActivityBar />
      <aside class="scrollbar-thin w-(--side-panel-width) shrink-0 overflow-x-hidden overflow-y-auto border-r border-border-default bg-surface-sidebar">
        <component :is="listPane" v-if="section.regions.listPane" />
      </aside>
      <main class="flex min-w-0 flex-1 flex-col overflow-hidden pr-safe">
        <component :is="mainPane" />
      </main>
    </template>

    <template v-else>
      <div class="absolute inset-0 flex flex-col bg-surface-app transition-transform duration-220 ease-[ease]">
        <div class="flex min-h-0 flex-1 flex-col overflow-hidden" v-show="mobileScreen === 'list'">
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
            </nav>
          </header>
          <component :is="listPane" v-if="section.regions.listPane" />
        </div>
      </div>
      <div
        class="absolute inset-0 z-10 flex flex-col bg-surface-app transition-transform duration-220 ease-[ease]"
        :class="mobileScreen === 'main' ? 'translate-x-0' : 'pointer-events-none translate-x-full'"
      >
        <header class="pt-safe flex h-[calc(44px+env(safe-area-inset-top))] shrink-0 items-center gap-2 border-b border-border-default bg-surface-sidebar px-3">
          <button class="flex cursor-pointer items-center gap-1 border-0 bg-transparent px-0 py-1 text-ui text-accent" @click="showList()">
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
    </template>
  </div>
</template>
