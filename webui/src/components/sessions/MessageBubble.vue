<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  side: "left" | "right";
  role: "user" | "assistant";
  kind?: "text" | "image";
  content?: string;
  label?: string;
  senderLabel?: string;
  metaChips?: string[];
  filename?: string | null;
  assetId?: string;
  imageUrl?: string;
  toolName?: string;
  timestampMs?: number;
  streaming?: boolean;
}>();

const emit = defineEmits<{
  previewImage: [];
}>();

const timeStr = computed(() => {
  if (!props.timestampMs) return "";
  const d = new Date(props.timestampMs);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
});
</script>

<template>
  <div class="flex items-end gap-2 px-3 py-1" :class="{ 'flex-row-reverse': side === 'right' }">
    <div
      class="flex h-7 w-7 shrink-0 items-center justify-center rounded text-small font-bold"
      :class="side === 'right' ? 'bg-surface-selected text-text-accent' : 'bg-surface-success text-success'"
    >
      <span>{{ side === "right" ? "U" : role === "assistant" ? "A" : "G" }}</span>
    </div>

    <div class="flex max-w-[72%] flex-col gap-0.5" :class="{ 'items-end': side === 'right' }">
      <div
        class="px-2.5 py-1.5 text-ui leading-6 wrap-break-word whitespace-pre-wrap"
        :class="[
          kind === 'image' ? 'flex min-w-50 flex-col gap-1' : '',
          streaming ? 'opacity-90' : '',
          side === 'right'
            ? 'rounded-[6px_6px_2px_6px] bg-accent text-text-on-accent'
            : 'rounded-[6px_6px_6px_2px] bg-surface-active text-text-secondary'
        ]"
      >
        <template v-if="kind === 'image'">
          <button
            v-if="imageUrl"
            class="cursor-zoom-in overflow-hidden rounded border border-border-default/50 bg-black/10 p-1"
            @click="emit('previewImage')"
          >
            <img :src="imageUrl" :alt="filename || assetId || '图片消息'" class="max-h-72 w-full rounded object-contain" />
          </button>
          <span class="text-small opacity-80">已发送图片</span>
          <span class="block wrap-break-word font-semibold">{{ filename || assetId || "未命名图片" }}</span>
          <span class="block font-mono text-small opacity-80">{{ toolName || "send_workspace_media_to_chat" }}</span>
        </template>
        <template v-else>
          <span v-if="label" class="mb-1 block text-small opacity-80">{{ label }}</span>
          <span class="block">{{ content }}</span>
          <span v-if="streaming" class="blink-cursor" />
        </template>
      </div>
      <div v-if="timeStr || senderLabel || (metaChips?.length ?? 0) > 0" class="flex flex-wrap items-center gap-1 px-0.5 text-small text-text-subtle" :class="{ 'justify-end': side === 'right' }">
        <span v-if="senderLabel">{{ senderLabel }}</span>
        <span v-if="timeStr">{{ timeStr }}</span>
        <span v-for="chip in metaChips ?? []" :key="chip" class="rounded-full border border-border-default bg-surface-input px-1.5 py-px text-[11px] leading-4 text-text-muted">{{ chip }}</span>
      </div>
    </div>
  </div>
</template>
