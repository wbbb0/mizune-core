<script setup lang="ts">
import { computed } from "vue";
import WorkbenchShell from "./WorkbenchShell.vue";
import { useWorkbenchRegistry } from "@/composables/workbench/useWorkbenchRegistry";

const props = defineProps<{
  sectionId: string;
}>();

const { getSectionById } = useWorkbenchRegistry();
const section = computed(() => getSectionById(props.sectionId));
</script>

<template>
  <WorkbenchShell :section="section" />
</template>
