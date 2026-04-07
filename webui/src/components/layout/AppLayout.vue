<script setup lang="ts">
/**
 * Root layout shell.
 *
 * Desktop  (≥1024px): ActivityBar | SidePanel | MainPanel  — three columns
 * Tablet   (768–1023): ActivityBar | content (side + main toggled via router)
 * Mobile   (<768px):  Full-screen stack; bottom nav replaces ActivityBar
 *
 * `showSide` / `showMain` signals from child pages control which panel is
 * visible on narrow viewports.
 */
import { ref, computed } from "vue";
import { useRoute } from "vue-router";
import { MessageSquare, SlidersHorizontal, Database, Settings, Folder } from "lucide-vue-next";
import ActivityBar from "./ActivityBar.vue";
import { useUiStore } from "@/stores/ui";
import { useVisualViewportInset } from "@/composables/useVisualViewportInset";

defineProps<{
  /** Slot name "side" and "main" expected */
  hasSide?: boolean;
}>();

const ui = useUiStore();
const route = useRoute();
const { viewportHeightStylePx } = useVisualViewportInset();

// On mobile, track which "screen" is active: list or detail
const mobileScreen = ref<"side" | "main">("side");

function goBack() {
  mobileScreen.value = "side";
}

// Expose for child pages to push into the detail screen
function openDetail() {
  mobileScreen.value = "main";
}
defineExpose({ openDetail });

const routeLabel = computed(() => {
  const map: Record<string, string> = {
    sessions: "会话",
    config:   "配置",
    data:     "数据",
    workspace:"工作区",
    settings: "设置"
  };
  return map[String(route.name)] ?? "";
});

const rootStyle = computed(() => (
  ui.isMobile
    ? { height: viewportHeightStylePx.value }
    : undefined
));
</script>

<template>
  <div
    class="flex h-full w-full overflow-hidden bg-surface-app text-text-primary"
    :class="ui.isMobile ? 'fixed inset-0' : 'relative'"
    :style="rootStyle"
  >
    <!-- ═══ DESKTOP / TABLET layout (≥768px) ═══ -->
    <template v-if="!ui.isMobile">
      <ActivityBar />

      <!-- Side panel slot -->
      <aside class="scrollbar-thin w-(--side-panel-width) shrink-0 overflow-x-hidden overflow-y-auto border-r border-border-default bg-surface-sidebar">
        <slot name="side" />
      </aside>

      <!-- Main panel slot -->
      <main class="flex min-w-0 flex-1 flex-col overflow-hidden pr-safe">
        <slot name="main" />
      </main>
    </template>

    <!-- ═══ MOBILE layout (<768px) ═══ -->
    <template v-else>
      <!-- Side screen (session list / config menu / data list) -->
      <div
        class="absolute inset-0 flex flex-col bg-surface-app transition-transform duration-220 ease-[ease]"
      >
        <!-- Mobile top bar -->
        <header class="pt-safe flex h-[calc(44px+env(safe-area-inset-top))] shrink-0 items-center gap-2 border-b border-border-default bg-surface-sidebar px-3">
          <span class="flex-1 font-semibold text-text-secondary">{{ routeLabel }}</span>
          <!-- Mobile nav icons inline in header -->
          <nav class="flex gap-1">
            <router-link to="/sessions" class="flex h-10 w-10 items-center justify-center rounded text-text-muted no-underline" :class="{ 'text-text-secondary': route.name === 'sessions' }">
              <MessageSquare :size="20" :stroke-width="1.5" />
            </router-link>
            <router-link to="/config" class="flex h-10 w-10 items-center justify-center rounded text-text-muted no-underline" :class="{ 'text-text-secondary': route.name === 'config' }">
              <SlidersHorizontal :size="20" :stroke-width="1.5" />
            </router-link>
            <router-link to="/data" class="flex h-10 w-10 items-center justify-center rounded text-text-muted no-underline" :class="{ 'text-text-secondary': route.name === 'data' }">
              <Database :size="20" :stroke-width="1.5" />
            </router-link>
            <router-link to="/workspace" class="flex h-10 w-10 items-center justify-center rounded text-text-muted no-underline" :class="{ 'text-text-secondary': route.name === 'workspace' }">
              <Folder :size="20" :stroke-width="1.5" />
            </router-link>
            <router-link to="/settings" class="flex h-10 w-10 items-center justify-center rounded text-text-muted no-underline" :class="{ 'text-text-secondary': route.name === 'settings' }">
              <Settings :size="20" :stroke-width="1.5" />
            </router-link>
          </nav>
        </header>
        <div class="min-h-0 flex-1 overflow-hidden">
          <slot name="side" :open-detail="openDetail" />
        </div>
      </div>

      <!-- Detail screen (chat / editor) -->
      <div
        class="absolute inset-0 flex flex-col bg-surface-app transition-transform duration-220 ease-[ease] z-10"
        :class="mobileScreen === 'main' ? 'translate-x-0' : 'translate-x-full pointer-events-none'"
      >
        <header class="pt-safe flex h-[calc(44px+env(safe-area-inset-top))] shrink-0 items-center gap-2 border-b border-border-default bg-surface-sidebar px-3">
          <button class="flex cursor-pointer items-center gap-1 border-0 bg-transparent px-0 py-1 text-ui text-accent" @click="goBack">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            <span>返回</span>
          </button>
          <slot name="mobile-header" />
        </header>
        <div class="min-h-0 flex-1 overflow-hidden">
          <slot name="main" />
        </div>
      </div>
    </template>
  </div>
</template>
