<script setup lang="ts">
import type { Component } from "vue";
import {
  File as FileIcon, FileArchive, FileAudio, FileCode, FileImage,
  FileJson, FileSpreadsheet, FileText, FileType, FileVideo
} from "lucide-vue-next";
import type { ChatTimelineContentPart } from "./chatTimeline";

withDefaults(defineProps<{ parts: readonly ChatTimelineContentPart[]; depth?: number }>(), { depth: 0 });
const emit = defineEmits<{ previewImage: [url?: string, title?: string] }>();

function embeddedTitle(relation: "reply" | "forward" | "message"): string {
  return relation === "reply" ? "引用消息" : relation === "forward" ? "转发聊天记录" : "消息片段";
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
  <div class="flex min-w-0 flex-col gap-1.5">
    <template v-for="(part, partIndex) in parts" :key="`${part.kind}:${partIndex}`">
      <details
        v-if="part.kind === 'embedded_message'"
        :open="part.relation === 'reply'"
        class="min-w-0 rounded border border-border-default/60 bg-surface-input/70 px-2 py-1.5 text-text-secondary whitespace-normal"
      >
        <summary class="cursor-pointer text-small font-medium wrap-break-word">
          {{ embeddedTitle(part.relation) }}
          <span v-if="part.relation === 'forward'" class="ml-1 font-normal text-text-muted">模型按需读取</span>
          <span v-if="part.senderName || part.senderId" class="ml-1 font-normal text-text-muted">{{ part.senderName || part.senderId }}</span>
        </summary>
        <div class="mt-1.5 flex min-w-0 flex-col gap-1.5 border-l-2 border-border-default pl-2">
          <span v-if="part.messageId" class="break-all text-small text-text-muted">引用索引：{{ part.messageId }}</span>
          <MessageContentParts
            v-if="depth < 8 && part.parts.length > 0"
            :parts="part.parts"
            :depth="depth + 1"
            @preview-image="(url, title) => emit('previewImage', url, title)"
          />
          <span v-else class="text-small text-text-muted">{{ depth >= 8 ? '嵌套层级过深，停止展开' : '消息正文未提供' }}</span>
          <span v-if="part.truncated" class="text-small text-text-muted">部分引用或聊天记录已截断</span>
        </div>
      </details>
      <span v-else-if="part.kind === 'text'" class="block whitespace-pre-wrap">{{ part.text }}</span>
      <button
        v-else-if="part.kind === 'image' || part.kind === 'emoji'"
        class="block cursor-zoom-in overflow-hidden rounded border-0 bg-transparent p-0 text-left"
        @click="emit('previewImage', part.imageUrl, part.sourceName || part.fileId || '图片消息')"
      >
        <img :src="part.imageUrl" :alt="part.sourceName || part.fileId" class="max-h-72 w-full rounded object-contain" />
      </button>
      <div v-else-if="part.kind === 'audio'" class="flex min-w-0 flex-col gap-1">
        <span v-if="part.aiGenerated" class="text-small opacity-80">人工智能生成语音</span>
        <audio v-if="part.contentUrl" :src="part.contentUrl" controls preload="none" class="max-w-full" :aria-label="part.name || '语音消息'" />
        <span v-else class="text-small">语音文件不可用</span>
      </div>
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
  </div>
</template>
