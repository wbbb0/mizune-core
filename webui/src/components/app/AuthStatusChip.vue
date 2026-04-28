<script setup lang="ts">
import { computed } from "vue";
import { Lock, LockOpen, X } from "lucide-vue-next";
import { useAuthStore } from "@/stores/auth";

const auth = useAuthStore();

const icon = computed(() => {
  if (!auth.enabled) {
    return LockOpen;
  }

  return auth.authenticated ? Lock : X;
});

const label = computed(() => {
  if (!auth.enabled) {
    return "认证关闭";
  }

  return auth.authenticated ? "已认证" : "未认证";
});
</script>

<template>
  <div class="flex items-center justify-center rounded px-1.5 py-1" :title="label" :aria-label="label">
    <component :is="icon" :size="14" :stroke-width="1.9" />
  </div>
</template>
