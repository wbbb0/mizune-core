<script setup lang="ts">
import type { MediaDeliveryState } from "./mediaDeliveryState";

defineProps<{ state: MediaDeliveryState }>();

const toneClasses: Record<MediaDeliveryState["tone"], string> = {
  neutral: "text-text-muted",
  active: "text-text-accent",
  success: "text-success",
  danger: "text-danger",
  warning: "text-warning"
};
</script>

<template>
  <div role="status" aria-live="polite" class="flex flex-col gap-0.5 text-small">
    <span class="font-medium" :class="toneClasses[state.tone]">{{ state.label }}</span>
    <span class="wrap-break-word text-text-muted">{{ state.detail }}</span>
  </div>
</template>
