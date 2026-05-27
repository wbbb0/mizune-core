<script setup lang="ts">
import { onMounted } from "vue";
import { LockKeyhole, LogOut } from "lucide-vue-next";
import { useUiStore } from "@/stores/ui";
import { useSettingsSection } from "@/composables/sections/useSettingsSection";
import { WorkbenchListItem, WorkbenchSidebarListPane } from "@workbench-kit/vue";

const ui = useUiStore();
const { auth, activeItem, selectItem, initializeSection } = useSettingsSection();
const settingsItems = [
  { id: "auth" as const, title: "认证", icon: LockKeyhole },
  { id: "logout" as const, title: "退出登录", icon: LogOut, requiresAuth: true }
];

onMounted(() => {
  void initializeSection();
});
</script>

<template>
  <WorkbenchSidebarListPane
    title="设置"
    :show-header="!ui.isMobile"
    :items="settingsItems.filter((item) => !item.requiresAuth || auth.enabled)"
    :item-key="(item) => item.id"
  >
    <template #item="{ item }">
      <WorkbenchListItem :selected="activeItem === item.id" :title="item.title" @select="selectItem(item.id)">
        <template #trailing>
          <component :is="item.icon" :size="14" :stroke-width="1.75" class="text-text-subtle" />
        </template>
      </WorkbenchListItem>
    </template>
  </WorkbenchSidebarListPane>
</template>
