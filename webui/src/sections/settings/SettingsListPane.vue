<script setup lang="ts">
import { onMounted } from "vue";
import { LockKeyhole, LogOut } from "lucide-vue-next";
import { useUiStore } from "@/stores/ui";
import { useSettingsSection } from "@/composables/sections/useSettingsSection";
import { WorkbenchAreaHeader, WorkbenchListItem } from "@/components/workbench/primitives";

const ui = useUiStore();
const { auth, activeItem, selectItem, initializeSection } = useSettingsSection();

onMounted(() => {
  void initializeSection();
});
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <WorkbenchAreaHeader v-if="!ui.isMobile" title="设置" />
    <div class="min-h-0 flex-1 overflow-y-auto">
      <WorkbenchListItem :selected="activeItem === 'auth'" title="认证" @select="selectItem('auth')">
        <template #trailing>
        <LockKeyhole :size="14" :stroke-width="1.75" class="text-text-subtle" />
        </template>
      </WorkbenchListItem>
      <WorkbenchListItem v-if="auth.enabled" :selected="activeItem === 'logout'" title="退出登录" @select="selectItem('logout')">
        <template #trailing>
        <LogOut :size="14" :stroke-width="1.75" class="text-text-subtle" />
        </template>
      </WorkbenchListItem>
    </div>
  </div>
</template>
