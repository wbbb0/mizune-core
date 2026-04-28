<script setup lang="ts">
import { RefreshCw } from "lucide-vue-next";
import { openImagePreviewWindow } from "@/components/common/imagePreviewWindow";
import { useWorkbenchWindows } from "@/components/workbench/windows/useWorkbenchWindows";
import { useWorkspaceSection } from "@/composables/sections/useWorkspaceSection";
import { WorkbenchAreaHeader, WorkbenchCard, WorkbenchEmptyState } from "@/components/workbench/primitives";

const windows = useWorkbenchWindows();

const {
  mode,
  selectedItem,
  selectedStoredFile,
  filePreview,
  previewError,
  fileImageSrc,
  loadingAssets,
  previewIcon,
  formatSize,
  formatTime,
  selectedStoredFileImageUrl
} = useWorkspaceSection();

function previewImage(src: string | null, title?: string) {
  if (!src) {
    return;
  }
  void openImagePreviewWindow(windows, { src, title });
}
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <div v-if="mode === 'files'" class="flex h-full flex-col overflow-hidden">
      <WorkbenchEmptyState v-if="!selectedItem" message="← 选择一个文件或目录" />
      <template v-else>
        <WorkbenchAreaHeader class="gap-3 px-4 py-2" :uppercase="false">
          <component :is="previewIcon(selectedItem)" :size="15" :stroke-width="1.8" class="shrink-0 text-text-muted" />
          <span class="min-w-0 flex-1 truncate font-mono text-small text-text-muted">{{ selectedItem.path }}</span>
          <span class="shrink-0 text-small text-text-subtle">{{ formatSize(selectedItem.sizeBytes) }}</span>
          <span class="shrink-0 text-small text-text-subtle">{{ formatTime(selectedItem.updatedAtMs) }}</span>
        </WorkbenchAreaHeader>

        <WorkbenchEmptyState v-if="selectedItem.kind === 'directory'" class="px-6 text-center">
          这是一个目录。可在左侧展开继续浏览。
        </WorkbenchEmptyState>
        <WorkbenchEmptyState v-else-if="previewError" class="px-6 text-center">
          {{ previewError }}
        </WorkbenchEmptyState>
        <div v-else-if="fileImageSrc" class="scrollbar-thin flex flex-1 items-center justify-center overflow-auto px-4 py-4">
          <button class="cursor-zoom-in overflow-hidden rounded-lg border border-border-default bg-surface-sidebar p-2" @click="previewImage(fileImageSrc, selectedItem.name)">
            <img :src="fileImageSrc" :alt="selectedItem.name" class="max-h-[70vh] max-w-full rounded object-contain" />
          </button>
        </div>
        <pre v-else-if="filePreview" class="scrollbar-thin m-0 flex-1 overflow-auto px-4 py-3 font-mono text-mono leading-6 text-text-primary whitespace-pre-wrap wrap-break-word">{{ filePreview.content }}</pre>
        <WorkbenchEmptyState v-else>
          <template #icon>
            <RefreshCw :size="14" :stroke-width="2" class="spin" />
          </template>
        </WorkbenchEmptyState>
      </template>
    </div>

    <div v-else class="flex h-full flex-col overflow-hidden">
      <WorkbenchEmptyState v-if="!selectedStoredFile" message="← 选择一个已保存文件" />
      <template v-else>
        <WorkbenchAreaHeader class="gap-3 px-4 py-2" :uppercase="false">
          <span class="min-w-0 flex-1 truncate font-mono text-small text-text-muted">{{ selectedStoredFile.chatFilePath }}</span>
          <span class="shrink-0 text-small text-text-subtle">{{ formatSize(selectedStoredFile.sizeBytes) }}</span>
          <span class="shrink-0 text-small text-text-subtle">{{ formatTime(selectedStoredFile.createdAtMs) }}</span>
        </WorkbenchAreaHeader>

        <div class="scrollbar-thin flex-1 overflow-auto px-4 py-4">
          <div v-if="selectedStoredFile.kind === 'image' || selectedStoredFile.kind === 'animated_image'" class="mb-4">
            <button class="cursor-zoom-in overflow-hidden rounded-lg border border-border-default bg-surface-sidebar p-2" @click="previewImage(selectedStoredFileImageUrl, selectedStoredFile.sourceName || selectedStoredFile.fileId)">
              <img v-if="selectedStoredFileImageUrl" :src="selectedStoredFileImageUrl" :alt="selectedStoredFile.sourceName || selectedStoredFile.fileId" class="max-h-[65vh] w-full rounded object-contain" />
            </button>
          </div>
          <WorkbenchCard v-else class="mb-4 text-text-muted" surface="sidebar" padding="lg">
            当前只支持图片直接预览，该文件将展示元数据。
          </WorkbenchCard>

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
            <dt class="text-text-subtle">Caption 状态</dt>
            <dd class="text-text-secondary">{{ selectedStoredFile.captionStatus || selectedStoredFile.captionObservation.status }}</dd>
            <dt class="text-text-subtle">Caption 模型</dt>
            <dd class="text-text-secondary">{{ selectedStoredFile.captionModelRef || "无" }}</dd>
            <dt class="text-text-subtle">Caption 时间</dt>
            <dd class="text-text-secondary">{{ selectedStoredFile.captionUpdatedAtMs ? new Date(selectedStoredFile.captionUpdatedAtMs).toLocaleString() : "无" }}</dd>
            <dt class="text-text-subtle">Caption 错误</dt>
            <dd class="text-text-secondary">{{ selectedStoredFile.captionError || "无" }}</dd>
          </dl>
        </div>
      </template>
    </div>

  </div>
</template>
