<script setup lang="ts">
import { computed } from "vue";
import { MoreHorizontal } from "lucide-vue-next";

const props = defineProps<{
  align?: "left" | "right";
  senderLabel?: string;
  timestampMs?: number;
  metaChips?: string[];
  actionsEnabled?: boolean;
}>();

const emit = defineEmits<{
  openActions: [];
}>();

const timeStr = computed(() => {
  if (!props.timestampMs) return "";
  const d = new Date(props.timestampMs);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
});

const visible = computed(() =>
  Boolean(timeStr.value)
  || Boolean(props.senderLabel)
  || (props.metaChips?.length ?? 0) > 0
  || props.actionsEnabled !== false
);

function openActions(): void {
  if (props.actionsEnabled === false) {
    return;
  }
  emit("openActions");
}
</script>

<template>
  <div
    v-if="visible"
    class="flex flex-wrap items-center gap-1 px-0.5 text-small text-text-subtle"
    :class="{ 'justify-end': align === 'right' }"
  >
    <span v-if="senderLabel">{{ senderLabel }}</span>
    <span v-if="timeStr">{{ timeStr }}</span>
    <button
      v-if="actionsEnabled !== false"
      class="inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded border-0 bg-transparent p-0 text-text-subtle transition-colors hover:text-text-primary"
      title="消息操作"
      @click="openActions"
    >
      <MoreHorizontal :size="14" :stroke-width="2" />
    </button>
    <span v-for="chip in metaChips ?? []" :key="chip" class="rounded-full border border-border-default bg-surface-input px-1.5 py-px text-[11px] leading-4 text-text-muted">{{ chip }}</span>
  </div>
</template>
