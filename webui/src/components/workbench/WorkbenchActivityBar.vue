<script setup lang="ts">
import { computed } from "vue";
import type { WorkbenchNavItem } from "./navigation";

const props = defineProps<{
  navItems: readonly WorkbenchNavItem[];
  activeNavItemId: string;
}>();

const emit = defineEmits<{
  navigate: [itemId: string];
}>();

const primaryNavItems = computed(() => props.navItems.filter((item) => item.placement === "primary"));
const bottomNavItems = computed(() => props.navItems.filter((item) => item.placement === "bottom"));
</script>

<template>
  <nav
    class="flex pl-safe w-[calc(var(--activity-bar-width)+env(safe-area-inset-left))] shrink-0 select-none flex-col justify-between border-r border-border-default bg-surface-sidebar"
  >
    <!-- Top: navigation icons -->
    <div class="flex flex-col items-center">
      <button
        v-for="item in primaryNavItems"
        :key="item.id"
        class="relative flex h-(--activity-bar-width) w-(--activity-bar-width) cursor-pointer items-center justify-center border-0 bg-transparent text-text-muted transition-colors hover:text-text-secondary before:absolute before:top-1/2 before:left-0 before:h-6 before:w-0.5 before:-translate-y-1/2 before:rounded-r-xs before:bg-text-secondary before:content-[''] before:opacity-0"
        :class="{ 'text-text-secondary before:opacity-100': activeNavItemId === item.id }"
        :title="item.title"
        @click="emit('navigate', item.id)"
      >
        <component :is="item.icon" :size="22" :stroke-width="1.5" />
        <span class="sr-only">{{ item.title }}</span>
      </button>
    </div>

    <div class="flex flex-col items-center border-t border-border-default/70 pt-1">
      <button
        v-for="item in bottomNavItems"
        :key="item.id"
        class="relative flex h-(--activity-bar-width) w-(--activity-bar-width) cursor-pointer items-center justify-center border-0 bg-transparent text-text-muted transition-colors hover:text-text-secondary before:absolute before:top-1/2 before:left-0 before:h-6 before:w-0.5 before:-translate-y-1/2 before:rounded-r-xs before:bg-text-secondary before:content-[''] before:opacity-0"
        :class="{ 'text-text-secondary before:opacity-100': activeNavItemId === item.id }"
        :title="item.title"
        @click="emit('navigate', item.id)"
      >
        <component :is="item.icon" :size="22" :stroke-width="1.5" />
        <span class="sr-only">{{ item.title }}</span>
      </button>
    </div>
  </nav>
</template>
