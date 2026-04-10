<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(defineProps<{
  text: string;
  tone?: "primary" | "muted";
  wrap?: boolean;
}>(), {
  tone: "primary",
  wrap: true
});

const textClass = computed(() => {
  return [
    "m-0 overflow-x-auto rounded-lg border border-border-default bg-surface-input p-2.5 font-mono text-mono",
    props.tone === "muted" ? "text-text-muted" : "text-text-primary",
    props.wrap ? "whitespace-pre-wrap wrap-break-word" : "whitespace-pre"
  ];
});
</script>

<template>
  <pre :class="textClass">{{ text }}</pre>
</template>