<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import WorkbenchShell from "@/components/workbench/WorkbenchShell.vue";
import type { WorkbenchStatusbarItem, WorkbenchTopbarMenu } from "@/components/workbench/chrome";
import { useWorkbenchChrome } from "@/composables/workbench/useWorkbenchChrome";
import { workbenchNavItems } from "@/sections/navigation";
import { useSectionRegistry } from "@/sections/useSectionRegistry";

const props = defineProps<{
  sectionId: string;
  topbarMenus?: WorkbenchTopbarMenu[];
  statusbarItems?: WorkbenchStatusbarItem[];
}>();

const route = useRoute();
const router = useRouter();
const { getSectionById } = useSectionRegistry();
const activeNavItemId = computed(() => String(route.name ?? ""));
const chrome = useWorkbenchChrome({
  navItems: workbenchNavItems,
  activeNavItemId,
  onNavigate: navigateWorkbench
});
const section = computed(() => getSectionById(props.sectionId));
const topbarMenus = computed(() => props.topbarMenus ?? chrome.topbarMenus.value);
const statusbarItems = computed(() => props.statusbarItems ?? chrome.statusbarItems.value);

function navigateWorkbench(itemId: string) {
  const item = workbenchNavItems.find((candidate) => candidate.id === itemId);
  if (item) {
    void router.push(item.path);
  }
}
</script>

<template>
  <WorkbenchShell
    :section="section"
    :nav-items="workbenchNavItems"
    :active-nav-item-id="activeNavItemId"
    :topbar-menus="topbarMenus"
    :statusbar-items="statusbarItems"
    @navigate="navigateWorkbench"
  />
</template>
