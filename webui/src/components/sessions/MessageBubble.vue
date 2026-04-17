<script setup lang="ts">
import { computed } from "vue";
import { Bot, MoreHorizontal, User, Users } from "lucide-vue-next";
import SessionGlyph, { type SessionGlyphModel } from "./SessionGlyph.vue";

const props = defineProps<{
  side: "left" | "right";
  role: "user" | "assistant";
  kind?: "text" | "image";
  content?: string;
  label?: string;
  senderLabel?: string;
  metaChips?: string[];
  sourceName?: string | null;
  fileRef?: string | null;
  fileId?: string | null;
  imageUrl?: string;
  toolName?: string;
  timestampMs?: number;
  streaming?: boolean;
  actionsEnabled?: boolean;
}>();

const emit = defineEmits<{
  previewImage: [];
  openActions: [];
}>();

const timeStr = computed(() => {
  if (!props.timestampMs) return "";
  const d = new Date(props.timestampMs);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
});

const bubbleGlyph = computed<SessionGlyphModel>(() => {
  if (props.side === "right") {
    return { kind: "icon", component: User, size: 14, strokeWidth: 2.1 };
  }
  if (props.role === "assistant") {
    return { kind: "icon", component: Bot, size: 14, strokeWidth: 2 };
  }
  return { kind: "icon", component: Users, size: 14, strokeWidth: 2 };
});

const bubbleGlyphToneClass = computed(() => {
  return props.side === "right" ? "bg-surface-selected text-text-accent" : "bg-surface-success text-success";
});

function openActions(): void {
  if (props.actionsEnabled === false) {
    return;
  }
  emit("openActions");
}
</script>

<template>
  <div
    class="flex items-end gap-2 px-3 py-1"
    :class="{ 'flex-row-reverse': side === 'right' }"
  >
    <SessionGlyph
      class="shrink-0"
      :glyph="bubbleGlyph"
      :tone-class="bubbleGlyphToneClass"
      size-class="h-7 w-7"
      text-class="text-small font-bold"
    />

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
            <img :src="imageUrl" :alt="sourceName || fileRef || fileId || '图片消息'" class="max-h-72 w-full rounded object-contain" />
          </button>
          <span class="text-small opacity-80">{{ role === 'user' ? '图片' : '已发送图片' }}</span>
          <span class="block wrap-break-word font-semibold">{{ sourceName || fileRef || fileId || "未命名图片" }}</span>
          <span v-if="toolName" class="block font-mono text-small opacity-80">{{ toolName }}</span>
        </template>
        <template v-else>
          <span v-if="label" class="mb-1 block text-small opacity-80">{{ label }}</span>
          <span class="block">{{ content }}</span>
          <span v-if="streaming" class="blink-cursor" />
        </template>
      </div>
      <div v-if="timeStr || senderLabel || (metaChips?.length ?? 0) > 0 || actionsEnabled !== false" class="flex flex-wrap items-center gap-1 px-0.5 text-small text-text-subtle" :class="{ 'justify-end': side === 'right' }">
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
    </div>
  </div>
</template>
