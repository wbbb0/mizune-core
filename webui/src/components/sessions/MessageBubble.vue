<script setup lang="ts">
import { computed, type Component } from "vue";
import {
  Bot,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileType,
  FileVideo,
  User,
  Users
} from "lucide-vue-next";
import MessageMetaLine from "./MessageMetaLine.vue";
import SessionGlyph, { type SessionGlyphModel } from "./SessionGlyph.vue";
import type { ChatTimelineContentPart } from "./chatTimeline";

const props = defineProps<{
  side: "left" | "right";
  role: "user" | "assistant";
  kind?: "text" | "image" | "content_parts";
  content?: string;
  parts?: ChatTimelineContentPart[];
  label?: string;
  senderLabel?: string;
  metaChips?: string[];
  sourceName?: string | null;
  fileRef?: string | null;
  fileId?: string | null;
  imageUrl?: string;
  toolName?: string;
  timestampMs?: number;
  actionsEnabled?: boolean;
}>();

const emit = defineEmits<{
  previewImage: [url?: string, title?: string];
  openActions: [];
}>();

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

function formatFileSize(sizeBytes: number | null | undefined): string {
  if (sizeBytes == null) {
    return "未知大小";
  }
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = sizeBytes / 1024;
  for (const unit of units) {
    if (value < 1024 || unit === units[units.length - 1]) {
      return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
    }
    value /= 1024;
  }
  return `${sizeBytes} B`;
}

function getFileExtension(name: string | null | undefined): string {
  return String(name ?? "").split(".").pop()?.trim().toLowerCase() ?? "";
}

function getFileIcon(part: Extract<ChatTimelineContentPart, { kind: "file" }>): Component {
  const mimeType = String(part.mimeType ?? "").trim().toLowerCase();
  const extension = getFileExtension(part.name);
  if (part.fileKind === "image" || part.fileKind === "animated_image" || mimeType.startsWith("image/")) {
    return FileImage;
  }
  if (part.fileKind === "video" || mimeType.startsWith("video/")) {
    return FileVideo;
  }
  if (part.fileKind === "audio" || mimeType.startsWith("audio/")) {
    return FileAudio;
  }
  if (mimeType === "application/pdf" || extension === "pdf") {
    return FileText;
  }
  if (["doc", "docx"].includes(extension)) {
    return FileType;
  }
  if (["xls", "xlsx", "csv"].includes(extension)) {
    return FileSpreadsheet;
  }
  if (extension === "json" || mimeType === "application/json") {
    return FileJson;
  }
  if (["xml", "yaml", "yml", "md", "markdown", "txt", "log"].includes(extension) || mimeType.startsWith("text/")) {
    return FileText;
  }
  if (["js", "jsx", "ts", "tsx", "vue", "css", "html", "sh", "py", "go", "rs", "java", "kt", "cpp", "c", "h"].includes(extension)) {
    return FileCode;
  }
  if (["zip", "rar", "7z", "tar", "gz"].includes(extension)) {
    return FileArchive;
  }
  return FileIcon;
}

function getFileTypeLabel(part: Extract<ChatTimelineContentPart, { kind: "file" }>): string {
  const extension = getFileExtension(part.name);
  if (extension) {
    return extension.toUpperCase();
  }
  if (part.mimeType) {
    return part.mimeType.split("/").pop()?.toUpperCase() ?? "FILE";
  }
  return "FILE";
}

</script>

<template>
  <div
    class="flex items-end gap-2 px-3 py-1"
    :class="{ 'flex-row-reverse': side === 'right' }"
    @contextmenu.prevent="openActions"
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
          kind === 'image' ? 'flex min-w-50 flex-col gap-1 !bg-transparent !p-0' : '',
          kind === 'content_parts' ? 'flex min-w-50 flex-col gap-1.5' : '',
          kind === 'image'
            ? ''
            : side === 'right'
            ? 'rounded-[6px_6px_2px_6px] bg-accent text-text-on-accent'
            : 'rounded-[6px_6px_6px_2px] bg-surface-active text-text-secondary'
        ]"
      >
        <template v-if="kind === 'image'">
          <button
            v-if="imageUrl"
            class="cursor-zoom-in overflow-hidden rounded border-0 bg-transparent p-0"
            @click="emit('previewImage')"
          >
            <img :src="imageUrl" :alt="sourceName || fileRef || fileId || '图片消息'" class="max-h-72 w-full rounded object-contain" />
          </button>
          <span v-if="toolName" class="block rounded bg-black/10 px-1.5 py-0.5 font-mono text-small opacity-80">{{ toolName }}</span>
        </template>
        <template v-else-if="kind === 'content_parts'">
          <template v-for="(part, partIndex) in parts ?? []" :key="`${part.kind}:${partIndex}`">
            <span v-if="part.kind === 'text'" class="block whitespace-pre-wrap">{{ part.text }}</span>
            <button
              v-else-if="part.kind === 'image' || part.kind === 'emoji'"
              class="block cursor-zoom-in overflow-hidden rounded border-0 bg-transparent p-0 text-left"
              @click="emit('previewImage', part.imageUrl, part.sourceName || part.fileId || '图片消息')"
            >
              <img :src="part.imageUrl" :alt="part.sourceName || part.fileId" class="max-h-72 w-full rounded object-contain" />
            </button>
            <span
              v-else-if="part.kind === 'file' && !part.contentUrl"
              class="flex min-w-0 items-center gap-1.5 overflow-hidden rounded border border-border-default/60 bg-surface-input pr-2 text-text-secondary"
            >
              <span class="flex h-12 w-12 shrink-0 flex-col items-center justify-center gap-0.5 border-r border-border-default bg-surface-sidebar text-text-muted">
                <component :is="getFileIcon(part)" :size="18" :stroke-width="1.75" />
                <span class="max-w-10 truncate font-mono text-[9px] leading-3 text-text-subtle">{{ getFileTypeLabel(part) }}</span>
              </span>
              <span class="min-w-0 flex-1 overflow-hidden">
                <span class="block truncate font-mono text-small text-text-secondary">{{ part.name || '聊天文件' }}</span>
                <span class="block truncate text-small text-text-muted">{{ formatFileSize(part.sizeBytes) }}</span>
              </span>
            </span>
            <a
              v-else-if="part.kind === 'file'"
              :href="part.contentUrl ?? undefined"
              target="_blank"
              download
              class="flex min-w-0 items-center gap-1.5 overflow-hidden rounded border border-border-default/60 bg-surface-input pr-2 text-text-secondary no-underline transition-colors hover:bg-surface-selected"
            >
              <span class="flex h-12 w-12 shrink-0 flex-col items-center justify-center gap-0.5 border-r border-border-default bg-surface-sidebar text-text-muted">
                <component :is="getFileIcon(part)" :size="18" :stroke-width="1.75" />
                <span class="max-w-10 truncate font-mono text-[9px] leading-3 text-text-subtle">{{ getFileTypeLabel(part) }}</span>
              </span>
              <span class="min-w-0 flex-1 overflow-hidden">
                <span class="block truncate font-mono text-small text-text-secondary">{{ part.name || '聊天文件' }}</span>
                <span class="block truncate text-small text-text-muted">{{ formatFileSize(part.sizeBytes) }}</span>
              </span>
            </a>
            <span v-else-if="part.kind === 'meta'" class="block rounded border border-border-default/50 bg-black/5 px-2 py-1 text-small opacity-85">{{ part.text }}</span>
          </template>
        </template>
        <template v-else>
          <span v-if="label" class="mb-1 block text-small opacity-80">{{ label }}</span>
          <span class="block">{{ content }}</span>
        </template>
      </div>
      <MessageMetaLine
        :align="side"
        :sender-label="senderLabel"
        :timestamp-ms="timestampMs"
        :meta-chips="metaChips"
        :actions-enabled="actionsEnabled"
        @open-actions="openActions"
      />
    </div>
  </div>
</template>
