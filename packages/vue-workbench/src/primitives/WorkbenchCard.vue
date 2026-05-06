<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(defineProps<{
  title?: string | null;
  compact?: boolean;
  surface?: "panel" | "sidebar" | "input" | "muted";
  padding?: "none" | "sm" | "md" | "lg";
}>(), {
  title: null,
  compact: false,
  surface: "input",
  padding: undefined
});

const cardClass = computed(() => {
  const padding = props.padding ?? (props.compact ? "sm" : "md");
  const surfaceClass = {
    panel: "bg-surface-panel",
    sidebar: "bg-surface-sidebar",
    input: props.compact
      ? "bg-surface-input"
      : "bg-[color-mix(in_srgb,var(--surface-input)_78%,transparent)]",
    muted: "bg-surface-muted"
  }[props.surface];
  const paddingClass = {
    none: "",
    sm: "px-2 py-1.5",
    md: "p-2.5",
    lg: "p-4"
  }[padding];

  return [
    props.compact ? "rounded-md border border-border-subtle" : "rounded-lg border border-border-default",
    surfaceClass,
    paddingClass
  ].filter(Boolean).join(" ");
});
</script>

<template>
  <section :class="cardClass">
    <div v-if="title" class="mb-1 text-small tracking-[0.05em] text-text-subtle uppercase">{{ title }}</div>
    <slot />
  </section>
</template>
