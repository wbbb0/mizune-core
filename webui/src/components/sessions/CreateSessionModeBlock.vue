<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  modes?: Array<{ id: string; title: string; description: string }>;
  values?: Record<string, unknown>;
}>();

const currentMode = computed(() => (
  (props.modes ?? []).find((item) => item.id === String(props.values?.modeId ?? "")) ?? null
));
</script>

<template>
  <div class="rounded border border-border-default bg-surface-sidebar px-3 py-2 text-small leading-5 text-text-muted">
    <div>{{ currentMode?.description ?? "选择新会话的运行模式。" }}</div>
    <div class="mt-2">当前会创建一个绑定到 `owner` 的 `web:*` 私聊会话，并使用所选 mode。</div>
  </div>
</template>
