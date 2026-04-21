<script setup lang="ts">
import { useSessionsSection } from "@/composables/sections/useSessionsSection";

const { store, mobileHeaderTitle } = useSessionsSection();
</script>

<template>
  <span v-if="store.active" class="font-mono text-ui font-medium text-text-secondary">
    {{ mobileHeaderTitle }}
  </span>
</template>
