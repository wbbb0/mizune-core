<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(defineProps<{
  title?: string | null;
  compact?: boolean;
}>(), {
  title: null,
  compact: false
});

const cardClass = computed(() => {
  return props.compact
    ? "rounded-md border border-border-subtle bg-surface-input px-2 py-1.5"
    : "rounded-lg border border-border-default bg-[color-mix(in_srgb,var(--surface-input)_78%,transparent)] p-2.5";
});
</script>

<template>
  <section :class="cardClass">
    <div v-if="title" class="mb-1 text-small tracking-[0.05em] text-text-subtle uppercase">{{ title }}</div>
    <slot />
  </section>
</template>