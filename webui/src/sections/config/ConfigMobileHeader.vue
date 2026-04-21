<script setup lang="ts">
import { computed } from "vue";
import { useConfigSection } from "@/composables/sections/useConfigSection";

const { model } = useConfigSection();
const title = computed(() => model.value?.title ?? "");
</script>

<template>
  <span v-if="title" class="truncate text-ui font-medium text-text-secondary">{{ title }}</span>
</template>
