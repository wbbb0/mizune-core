<script setup lang="ts">
import { computed } from "vue";
import WorkbenchShell from "./WorkbenchShell.vue";
import type { WorkbenchStatusbarItem, WorkbenchTopbarMenu } from "@/components/workbench/chrome";
import { useWorkbenchRegistry } from "@/composables/workbench/useWorkbenchRegistry";
import { useWorkbenchChrome } from "@/composables/workbench/useWorkbenchChrome";

const props = defineProps<{
  sectionId: string;
  topbarMenus?: WorkbenchTopbarMenu[];
  statusbarItems?: WorkbenchStatusbarItem[];
}>();

const { getSectionById } = useWorkbenchRegistry();
const chrome = useWorkbenchChrome();
const section = computed(() => getSectionById(props.sectionId));
const topbarMenus = computed(() => props.topbarMenus ?? chrome.topbarMenus.value);
const statusbarItems = computed(() => props.statusbarItems ?? chrome.statusbarItems.value);
</script>

<template>
  <WorkbenchShell :section="section" :topbar-menus="topbarMenus" :statusbar-items="statusbarItems" />
</template>
