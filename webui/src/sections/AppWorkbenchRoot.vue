<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import WorkbenchRoot from "@/components/workbench/WorkbenchRoot.vue";
import { useAppWorkbenchChrome } from "@/composables/useAppWorkbenchChrome";
import { useUiStore } from "@/stores/ui";
import { workbenchNavItems } from "@/sections/navigation";
import { useWorkbenchViewRegistry } from "@/sections/useWorkbenchViewRegistry";

const route = useRoute();
const router = useRouter();
const ui = useUiStore();
const { getViewById } = useWorkbenchViewRegistry();

const activeNavItemId = computed(() => {
  const metaViewId = route.meta.workbenchViewId;
  return typeof metaViewId === "string" ? metaViewId : "sessions";
});
const chrome = useAppWorkbenchChrome({
  navItems: workbenchNavItems,
  activeNavItemId,
  onNavigate: navigateWorkbench
});
const view = computed(() => getViewById(activeNavItemId.value));
const topbarMenus = computed(() => chrome.topbarMenus.value);
const statusbarItems = computed(() => chrome.statusbarItems.value);

function navigateWorkbench(itemId: string) {
  const item = workbenchNavItems.find((candidate) => candidate.id === itemId);
  if (item && route.path !== item.path) {
    void router.push(item.path);
  }
}
</script>

<template>
  <WorkbenchRoot
    :view="view"
    :nav-items="workbenchNavItems"
    :active-nav-item-id="activeNavItemId"
    :topbar-menus="topbarMenus"
    :statusbar-items="statusbarItems"
    :is-mobile="ui.isMobile"
    @navigate="navigateWorkbench"
  />
</template>
