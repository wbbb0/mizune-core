<script setup lang="ts">
import { computed } from "vue";
import { useSettingsSection } from "@/composables/sections/useSettingsSection";

const { activeItem } = useSettingsSection();
const title = computed(() => (
  activeItem.value === "auth"
    ? "认证设置"
    : activeItem.value === "logout"
      ? "退出登录"
      : ""
));
</script>

<template>
  <span v-if="title" class="truncate text-ui font-medium text-text-secondary">{{ title }}</span>
</template>
