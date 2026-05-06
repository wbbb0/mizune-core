<script setup lang="ts">
import type { WorkbenchStatusbarItem } from "./chrome";

const props = defineProps<{
  items: WorkbenchStatusbarItem[];
}>();
</script>

<template>
  <footer class="pb-safe flex min-h-8 shrink-0 items-center gap-2 border-t border-border-default bg-surface-sidebar px-2 text-text-muted">
    <component
      :is="item.component"
      v-for="item in props.items"
      :key="item.id"
      v-bind="item.props"
    />
  </footer>
</template>
