<script setup lang="ts">
import { computed } from "vue";
import { useRouter, useRoute } from "vue-router";
import { MessageSquare, SlidersHorizontal, Database, Settings, Folder } from "lucide-vue-next";

const router = useRouter();
const route = useRoute();

const primaryNavItems = [
  { name: "sessions", path: "/sessions", icon: MessageSquare, label: "会话" },
  { name: "config", path: "/config", icon: SlidersHorizontal, label: "配置" },
  { name: "data", path: "/data", icon: Database, label: "数据" },
  { name: "files", path: "/files", icon: Folder, label: "文件" },
] as const;

const bottomNavItems = [
  { name: "settings", path: "/settings", icon: Settings, label: "设置" }
] as const;

const currentRoute = computed(() => route.name as string);
</script>

<template>
  <nav
    class="flex pl-safe pb-safe w-[calc(var(--activity-bar-width)+env(safe-area-inset-left))] shrink-0 select-none flex-col justify-between border-r border-border-default bg-surface-sidebar"
  >
    <!-- Top: navigation icons -->
    <div class="flex flex-col items-center">
      <button
        v-for="item in primaryNavItems"
        :key="item.name"
        class="relative flex h-[var(--activity-bar-width)] w-[var(--activity-bar-width)] cursor-pointer items-center justify-center border-0 bg-transparent text-text-muted transition-colors hover:text-text-secondary before:absolute before:top-1/2 before:left-0 before:h-6 before:w-0.5 before:-translate-y-1/2 before:rounded-r-[2px] before:bg-text-secondary before:content-[''] before:opacity-0"
        :class="{ 'text-text-secondary before:opacity-100': currentRoute === item.name }"
        :title="item.label"
        @click="router.push(item.path)"
      >
        <component :is="item.icon" :size="22" :stroke-width="1.5" />
        <span class="sr-only">{{ item.label }}</span>
      </button>
    </div>

    <div class="flex flex-col items-center border-t border-border-default/70 pt-1">
      <button
        v-for="item in bottomNavItems"
        :key="item.name"
        class="relative flex h-[var(--activity-bar-width)] w-[var(--activity-bar-width)] cursor-pointer items-center justify-center border-0 bg-transparent text-text-muted transition-colors hover:text-text-secondary before:absolute before:top-1/2 before:left-0 before:h-6 before:w-0.5 before:-translate-y-1/2 before:rounded-r-[2px] before:bg-text-secondary before:content-[''] before:opacity-0"
        :class="{ 'text-text-secondary before:opacity-100': currentRoute === item.name }"
        :title="item.label"
        @click="router.push(item.path)"
      >
        <component :is="item.icon" :size="22" :stroke-width="1.5" />
        <span class="sr-only">{{ item.label }}</span>
      </button>
    </div>
  </nav>
</template>
