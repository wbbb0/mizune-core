<script setup lang="ts">
import { onMounted } from "vue";
import { LockKeyhole, LogOut } from "lucide-vue-next";
import { useUiStore } from "@/stores/ui";
import { useSettingsSection } from "@/composables/sections/useSettingsSection";

const ui = useUiStore();
const { auth, activeItem, selectItem, initializeSection } = useSettingsSection();

onMounted(() => {
  void initializeSection();
});
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <div v-if="!ui.isMobile" class="panel-header flex h-10 shrink-0 items-center border-b px-3">
      <span class="text-small font-semibold tracking-[0.08em] text-text-muted uppercase">设置</span>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto">
      <button class="list-row flex w-full items-center justify-between px-3 py-1.75 text-left" :class="{ 'is-selected': activeItem === 'auth' }" @click="selectItem('auth')">
        <span class="text-ui text-text-secondary">认证</span>
        <LockKeyhole :size="14" :stroke-width="1.75" class="text-text-subtle" />
      </button>
      <button v-if="auth.enabled" class="list-row flex w-full items-center justify-between px-3 py-1.75 text-left" :class="{ 'is-selected': activeItem === 'logout' }" @click="selectItem('logout')">
        <span class="text-ui text-text-secondary">退出登录</span>
        <LogOut :size="14" :stroke-width="1.75" class="text-text-subtle" />
      </button>
    </div>
  </div>
</template>
