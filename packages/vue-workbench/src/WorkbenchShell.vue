<script setup lang="ts">
import DesktopWorkbench from "./DesktopWorkbench.vue";
import MobileWorkbench from "./MobileWorkbench.vue";
import type { WorkbenchStatusbarItem, WorkbenchTopbarMenu } from "./chrome";
import type { WorkbenchNavItem } from "./navigation";
import type { WorkbenchRuntime } from "./runtime/workbenchRuntime";
import type { WorkbenchView } from "./types";

const props = defineProps<{
  runtime: WorkbenchRuntime;
  view: WorkbenchView;
  navItems: readonly WorkbenchNavItem[];
  activeNavItemId: string;
  topbarMenus: WorkbenchTopbarMenu[];
  statusbarItems: WorkbenchStatusbarItem[];
  isMobile: boolean;
}>();

const emit = defineEmits<{
  navigate: [itemId: string];
}>();
</script>

<template>
  <DesktopWorkbench
    v-if="!isMobile"
    :runtime="props.runtime"
    :view="view"
    :nav-items="navItems"
    :active-nav-item-id="activeNavItemId"
    :topbar-menus="topbarMenus"
    :statusbar-items="statusbarItems"
    @navigate="emit('navigate', $event)"
  />
  <MobileWorkbench
    v-else
    :runtime="props.runtime"
    :view="view"
    :nav-items="navItems"
    :active-nav-item-id="activeNavItemId"
    :topbar-menus="topbarMenus"
    :statusbar-items="statusbarItems"
    @navigate="emit('navigate', $event)"
  />
</template>
