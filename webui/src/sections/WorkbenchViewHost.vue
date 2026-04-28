<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import WorkbenchShell from "@/components/workbench/WorkbenchShell.vue";
import type { WorkbenchStatusbarItem, WorkbenchTopbarMenu } from "@/components/workbench/chrome";
import { useAppWorkbenchChrome } from "@/composables/useAppWorkbenchChrome";
import { useUiStore } from "@/stores/ui";
import { workbenchNavItems } from "@/sections/navigation";
import { useWorkbenchViewRegistry } from "@/sections/useWorkbenchViewRegistry";

const props = defineProps<{
  viewId: string;
  topbarMenus?: WorkbenchTopbarMenu[];
  statusbarItems?: WorkbenchStatusbarItem[];
}>();

const route = useRoute();
const router = useRouter();
const ui = useUiStore();
const { getViewById } = useWorkbenchViewRegistry();
const activeNavItemId = computed(() => String(route.name ?? ""));
const chrome = useAppWorkbenchChrome({
  navItems: workbenchNavItems,
  activeNavItemId,
  onNavigate: navigateWorkbench
});
const view = computed(() => getViewById(props.viewId));
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
    :view="view"
    :nav-items="workbenchNavItems"
    :active-nav-item-id="activeNavItemId"
    :topbar-menus="topbarMenus"
    :statusbar-items="statusbarItems"
    :is-mobile="ui.isMobile"
    @navigate="navigateWorkbench"
  />
</template>
