<script setup lang="ts">
import { onMounted } from "vue";
import { useUiStore } from "@/stores/ui";
import { useConfigSection } from "@/composables/sections/useConfigSection";

const ui = useUiStore();
const { resources, selectedKey, selectResource, refreshResources } = useConfigSection();

onMounted(() => {
  void refreshResources();
});
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <div v-if="!ui.isMobile" class="panel-header flex h-10 shrink-0 items-center border-b px-3">
      <span class="text-small font-semibold tracking-[0.08em] text-text-muted uppercase">配置编辑器</span>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto">
      <button
        v-for="resource in resources"
        :key="resource.key"
        class="list-row flex w-full items-center justify-between px-3 py-1.75 text-left"
        :class="{ 'is-selected': selectedKey === resource.key }"
        @click="selectResource(resource.key)"
      >
        <span class="text-ui text-text-secondary">{{ resource.title }}</span>
        <span class="rounded-full bg-surface-muted px-1.5 text-small text-text-subtle">{{ resource.kind }}</span>
      </button>
      <div v-if="resources.length === 0" class="px-3 py-6 text-center text-small text-text-subtle">暂无可编辑资源</div>
    </div>
  </div>
</template>
