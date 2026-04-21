<script setup lang="ts">
import { useSessionsSection } from "@/composables/sections/useSessionsSection";

const section = useSessionsSection();
</script>

<template>
  <span v-if="section.store.active" class="font-mono text-ui font-medium text-text-secondary">
    {{ section.mobileHeaderTitle }}
  </span>
</template>
