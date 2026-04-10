<script setup lang="ts">
withDefaults(defineProps<{
  expanded: boolean;
  collapsedLabel: string;
  expandedLabel: string;
  summary?: string | null;
}>(), {
  summary: null
});

defineEmits<{
  toggle: [];
}>();
</script>

<template>
  <div class="flex flex-col gap-2">
    <button
      class="flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg border border-border-default bg-surface-input px-2.5 py-1.75 text-small text-text-muted hover:text-text-primary"
      @click="$emit('toggle')"
    >
      <span>{{ expanded ? expandedLabel : collapsedLabel }}</span>
      <span v-if="summary">{{ summary }}</span>
    </button>
    <div v-if="expanded" class="flex flex-col gap-2">
      <slot />
    </div>
  </div>
</template>