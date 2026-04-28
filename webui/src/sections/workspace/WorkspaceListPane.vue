<script setup lang="ts">
import { onMounted } from "vue";
import { RefreshCw } from "lucide-vue-next";
import WorkspaceFileTree from "@/components/workspace/WorkspaceFileTree.vue";
import { useWorkspaceSection } from "@/composables/sections/useWorkspaceSection";
import type { ChatFileSummary } from "@/api/workspace";
import { WorkbenchAreaHeader, WorkbenchEmptyState, WorkbenchListItem } from "@/components/workbench/primitives";

const {
  mode,
  loadingFiles,
  loadingAssets,
  currentRootItems,
  expandedPaths,
  itemsByPath,
  selectedPath,
  storedFileList,
  selectedStoredFile,
  initializeSection,
  toggleDirectory,
  selectItem,
  selectStoredFile,
  refreshCurrentMode
} = useWorkspaceSection();

onMounted(() => {
  void initializeSection();
});

function captionStatus(file: ChatFileSummary): "missing" | "queued" | "ready" | "failed" {
  return file.captionStatus ?? file.captionObservation.status;
}

function captionStatusLabel(file: ChatFileSummary): string {
  const status = captionStatus(file);
  if (status === "ready") return "已描述";
  if (status === "queued") return "描述中";
  if (status === "failed") return "描述失败";
  return "未描述";
}

function captionStatusClass(file: ChatFileSummary): string {
  const status = captionStatus(file);
  if (status === "ready") return "border-[color-mix(in_srgb,var(--success)_45%,transparent)] bg-surface-success text-success";
  if (status === "queued") return "border-border-strong bg-surface-muted text-text-muted";
  if (status === "failed") return "border-[color-mix(in_srgb,var(--danger)_45%,transparent)] bg-surface-danger text-danger";
  return "border-border-default bg-surface-muted text-text-subtle";
}
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <WorkbenchAreaHeader>
      <div class="inline-flex rounded-md border border-border-default bg-surface-input p-0.5">
        <button class="px-2 py-0.75 text-small" :class="mode === 'files' ? 'rounded bg-surface-selected-muted text-text-secondary' : 'text-text-muted'" @click="mode = 'files'">文件</button>
        <button class="px-2 py-0.75 text-small" :class="mode === 'stored-files' ? 'rounded bg-surface-selected-muted text-text-secondary' : 'text-text-muted'" @click="mode = 'stored-files'">已保存</button>
      </div>
      <template #actions>
      <button class="btn-ghost" :disabled="loadingFiles || loadingAssets" title="刷新" @click="refreshCurrentMode">
        <RefreshCw :size="14" :stroke-width="2" :class="{ spin: loadingFiles || loadingAssets }" />
      </button>
      </template>
    </WorkbenchAreaHeader>

    <div v-if="mode === 'files'" class="scrollbar-thin min-h-0 flex-1 overflow-auto px-2 py-2">
      <WorkspaceFileTree
        :items="currentRootItems"
        :expanded-paths="expandedPaths"
        :items-by-path="itemsByPath"
        :selected-path="selectedPath"
        @toggle-directory="toggleDirectory"
        @select-item="selectItem"
      />
      <WorkbenchEmptyState v-if="!loadingFiles && currentRootItems.length === 0" :centered="false" class="justify-center px-3 py-6 text-center text-small text-text-subtle" message="工作区为空" />
    </div>

    <div v-else class="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
      <WorkbenchListItem
        v-for="file in storedFileList"
        :key="file.fileId"
        :selected="selectedStoredFile?.fileId === file.fileId"
        :dense="false"
        multiline
        @select="selectStoredFile(file)"
      >
        <div class="min-w-0">
          <div class="truncate text-ui text-text-secondary">{{ file.sourceName || file.fileRef || file.fileId }}</div>
          <div class="truncate font-mono text-small text-text-subtle">{{ file.fileRef }}</div>
        </div>
        <template #trailing>
        <div class="flex shrink-0 flex-col items-end gap-1">
          <span class="rounded-full bg-surface-muted px-1.5 text-small text-text-subtle">{{ file.kind }}</span>
          <span
            v-if="file.kind === 'image' || file.kind === 'animated_image'"
            class="rounded-full border px-1.5 text-small"
            :class="captionStatusClass(file)"
          >
            {{ captionStatusLabel(file) }}
          </span>
        </div>
        </template>
      </WorkbenchListItem>
      <WorkbenchEmptyState v-if="!loadingAssets && storedFileList.length === 0" :centered="false" class="justify-center px-3 py-6 text-center text-small text-text-subtle" message="暂无已保存文件" />
    </div>
  </div>
</template>
