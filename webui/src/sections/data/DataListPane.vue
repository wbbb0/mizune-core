<script setup lang="ts">
import { onMounted } from "vue";
import { useUiStore } from "@/stores/ui";
import { useDataSection } from "@/composables/sections/useDataSection";

const ui = useUiStore();
const { resources, selectedKey, selectResource, refreshResources, resourceBadge } = useDataSection();

onMounted(() => {
  void refreshResources();
});
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <div v-if="!ui.isMobile" class="panel-header flex h-10 shrink-0 items-center border-b px-3">
      <span class="text-small font-semibold tracking-[0.08em] text-text-muted uppercase">数据</span>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto">
      <button
        v-for="entry in resources"
        :key="entry.key"
        class="list-row flex w-full items-center justify-between px-3 py-1.75 text-left"
        :class="{ 'is-selected': selectedKey === entry.key }"
        @click="selectResource(entry.key)"
      >
        <span class="text-ui text-text-secondary">{{ entry.title }}</span>
        <span class="rounded-full bg-surface-muted px-1.5 text-small text-text-subtle">{{ resourceBadge(entry) }}</span>
      </button>
      <div v-if="resources.length === 0" class="px-3 py-6 text-center text-small text-text-subtle">暂无数据资源</div>
    </div>
  </div>
</template>
