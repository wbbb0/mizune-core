<script setup lang="ts">
import { useResourcesSection } from "@/composables/sections/useResourcesSection";

const { mobileHeaderTitle } = useResourcesSection();
</script>

<template>
  <div class="truncate text-label font-medium text-text-primary">{{ mobileHeaderTitle }}</div>
</template>
