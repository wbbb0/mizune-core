<script setup lang="ts">
import { RefreshCw } from "lucide-vue-next";
import ImagePreviewDialog from "@/components/common/ImagePreviewDialog.vue";
import { useWorkspaceSection } from "@/composables/sections/useWorkspaceSection";

const {
  mode,
  selectedItem,
  selectedStoredFile,
  filePreview,
  previewError,
  fileImageSrc,
  dialogImageSrc,
  loadingAssets,
  previewIcon,
  formatSize,
  formatTime,
  selectedStoredFileImageUrl,
  openImageDialog,
  closeImageDialog
} = useWorkspaceSection();
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <div v-if="mode === 'files'" class="flex h-full flex-col overflow-hidden">
      <div v-if="!selectedItem" class="panel-empty flex flex-1 items-center justify-center gap-2">← 选择一个文件或目录</div>
      <template v-else>
        <header class="toolbar-header flex h-10 shrink-0 items-center gap-3 border-b px-4 py-2">
          <component :is="previewIcon(selectedItem)" :size="15" :stroke-width="1.8" class="shrink-0 text-text-muted" />
          <span class="min-w-0 flex-1 truncate font-mono text-small text-text-muted">{{ selectedItem.path }}</span>
          <span class="shrink-0 text-small text-text-subtle">{{ formatSize(selectedItem.sizeBytes) }}</span>
          <span class="shrink-0 text-small text-text-subtle">{{ formatTime(selectedItem.updatedAtMs) }}</span>
        </header>

        <div v-if="selectedItem.kind === 'directory'" class="panel-empty flex flex-1 items-center justify-center px-6 text-center">
          这是一个目录。可在左侧展开继续浏览。
        </div>
        <div v-else-if="previewError" class="panel-empty flex flex-1 items-center justify-center px-6 text-center">
          {{ previewError }}
        </div>
        <div v-else-if="fileImageSrc" class="scrollbar-thin flex flex-1 items-center justify-center overflow-auto px-4 py-4">
          <button class="cursor-zoom-in overflow-hidden rounded-lg border border-border-default bg-surface-sidebar p-2" @click="openImageDialog(fileImageSrc)">
            <img :src="fileImageSrc" :alt="selectedItem.name" class="max-h-[70vh] max-w-full rounded object-contain" />
          </button>
        </div>
        <pre v-else-if="filePreview" class="scrollbar-thin m-0 flex-1 overflow-auto px-4 py-3 font-mono text-mono leading-6 text-text-primary whitespace-pre-wrap wrap-break-word">{{ filePreview.content }}</pre>
        <div v-else class="panel-empty flex flex-1 items-center justify-center gap-2">
          <RefreshCw :size="14" :stroke-width="2" class="spin" />
        </div>
      </template>
    </div>

    <div v-else class="flex h-full flex-col overflow-hidden">
      <div v-if="!selectedStoredFile" class="panel-empty flex flex-1 items-center justify-center gap-2">← 选择一个已保存文件</div>
      <template v-else>
        <header class="toolbar-header flex shrink-0 items-center gap-3 border-b px-4 py-2">
          <span class="min-w-0 flex-1 truncate font-mono text-small text-text-muted">{{ selectedStoredFile.chatFilePath }}</span>
          <span class="shrink-0 text-small text-text-subtle">{{ formatSize(selectedStoredFile.sizeBytes) }}</span>
          <span class="shrink-0 text-small text-text-subtle">{{ formatTime(selectedStoredFile.createdAtMs) }}</span>
        </header>

        <div class="scrollbar-thin flex-1 overflow-auto px-4 py-4">
          <div v-if="selectedStoredFile.kind === 'image' || selectedStoredFile.kind === 'animated_image'" class="mb-4">
            <button class="cursor-zoom-in overflow-hidden rounded-lg border border-border-default bg-surface-sidebar p-2" @click="openImageDialog(selectedStoredFileImageUrl)">
              <img v-if="selectedStoredFileImageUrl" :src="selectedStoredFileImageUrl" :alt="selectedStoredFile.sourceName || selectedStoredFile.fileId" class="max-h-[65vh] w-full rounded object-contain" />
            </button>
          </div>
          <div v-else class="mb-4 rounded-lg border border-border-default bg-surface-sidebar px-4 py-3 text-text-muted">
            当前只支持图片直接预览，该文件将展示元数据。
          </div>

          <dl class="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-2 text-ui">
            <dt class="text-text-subtle">fileId</dt>
            <dd class="min-w-0 font-mono text-text-secondary">{{ selectedStoredFile.fileId }}</dd>
            <dt class="text-text-subtle">fileRef</dt>
            <dd class="min-w-0 font-mono text-text-secondary">{{ selectedStoredFile.fileRef }}</dd>
            <dt class="text-text-subtle">原始文件名</dt>
            <dd class="min-w-0 text-text-secondary">{{ selectedStoredFile.sourceName }}</dd>
            <dt class="text-text-subtle">类型</dt>
            <dd class="text-text-secondary">{{ selectedStoredFile.kind }}</dd>
            <dt class="text-text-subtle">MIME</dt>
            <dd class="font-mono text-text-secondary">{{ selectedStoredFile.mimeType }}</dd>
            <dt class="text-text-subtle">来源</dt>
            <dd class="text-text-secondary">{{ selectedStoredFile.origin }}</dd>
            <dt class="text-text-subtle">工作区路径</dt>
            <dd class="min-w-0 font-mono text-text-secondary">{{ selectedStoredFile.chatFilePath }}</dd>
            <dt class="text-text-subtle">Caption</dt>
            <dd class="text-text-secondary">{{ selectedStoredFile.caption || "无" }}</dd>
          </dl>
        </div>
      </template>
    </div>

    <ImagePreviewDialog
      :open="dialogImageSrc !== null"
      :src="dialogImageSrc || ''"
      :title="selectedStoredFile?.sourceName || selectedStoredFile?.fileRef || selectedItem?.name"
      @close="closeImageDialog"
    />
  </div>
</template>
