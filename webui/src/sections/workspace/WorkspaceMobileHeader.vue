<script setup lang="ts">
import { computed } from "vue";
import { useWorkspaceSection } from "@/composables/sections/useWorkspaceSection";

const { mobileHeaderTitle } = useWorkspaceSection();
const title = computed(() => mobileHeaderTitle.value);
</script>

<template>
  <span class="truncate text-ui font-medium text-text-secondary">{{ title }}</span>
</template>
