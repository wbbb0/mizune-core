<script setup lang="ts">
import { computed } from "vue";
import { useDataSection } from "@/composables/sections/useDataSection";

const { mobileHeaderTitle } = useDataSection();
const title = computed(() => mobileHeaderTitle.value);
</script>

<template>
  <span v-if="title" class="truncate text-ui font-medium text-text-secondary">{{ title }}</span>
</template>
