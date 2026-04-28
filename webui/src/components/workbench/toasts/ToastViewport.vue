<script setup lang="ts">
import { computed } from "vue";
import { AlertCircle, CheckCircle2, Info } from "lucide-vue-next";
import { useWorkbenchToasts } from "./useWorkbenchToasts";

const toast = useWorkbenchToasts();

const toasts = computed(() => toast.items.value);

function iconFor(type: "success" | "error" | "info") {
  if (type === "success") return CheckCircle2;
  if (type === "error") return AlertCircle;
  return Info;
}

function toneClassFor(type: "success" | "error" | "info") {
  if (type === "success") {
    return "border-success/35 bg-surface-success text-success";
  }
  if (type === "error") {
    return "border-danger/35 bg-surface-danger text-danger";
  }
  return "border-border-default bg-surface-panel text-text-secondary";
}
</script>

<template>
  <div class="pointer-events-none fixed inset-x-0 top-0 z-60 flex justify-center px-3 pt-[calc(env(safe-area-inset-top,0px)+0.75rem)]">
    <div class="flex w-full max-w-xl flex-col gap-2">
      <button
        v-for="item in toasts"
        :key="item.id"
        type="button"
        class="pointer-events-auto flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left shadow-lg backdrop-blur-sm transition-transform hover:-translate-y-px"
        :class="toneClassFor(item.type)"
        @click="toast.dismiss(item.id)"
      >
        <component :is="iconFor(item.type)" :size="16" :stroke-width="2" class="mt-0.5 shrink-0" />
        <span class="min-w-0 flex-1 text-ui leading-6 wrap-break-word">{{ item.message }}</span>
      </button>
    </div>
  </div>
</template>
