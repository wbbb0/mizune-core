<script setup lang="ts">
import { onMounted } from "vue";
import { RefreshCw } from "lucide-vue-next";
import WorkspaceFileTree from "@/components/workspace/WorkspaceFileTree.vue";
import { useWorkspaceSection } from "@/composables/sections/useWorkspaceSection";

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
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <div class="panel-header flex h-10 shrink-0 items-center justify-between border-b px-3">
      <div class="inline-flex rounded-md border border-border-default bg-surface-input p-0.5">
        <button class="px-2 py-0.75 text-small" :class="mode === 'files' ? 'rounded bg-surface-selected-muted text-text-secondary' : 'text-text-muted'" @click="mode = 'files'">文件</button>
        <button class="px-2 py-0.75 text-small" :class="mode === 'stored-files' ? 'rounded bg-surface-selected-muted text-text-secondary' : 'text-text-muted'" @click="mode = 'stored-files'">已保存</button>
      </div>
      <button class="btn-ghost" :disabled="loadingFiles || loadingAssets" title="刷新" @click="refreshCurrentMode">
        <RefreshCw :size="14" :stroke-width="2" :class="{ spin: loadingFiles || loadingAssets }" />
      </button>
    </div>

    <div v-if="mode === 'files'" class="scrollbar-thin min-h-0 flex-1 overflow-auto px-2 py-2">
      <WorkspaceFileTree
        :items="currentRootItems"
        :expanded-paths="expandedPaths"
        :items-by-path="itemsByPath"
        :selected-path="selectedPath"
        @toggle-directory="toggleDirectory"
        @select-item="selectItem"
      />
      <div v-if="!loadingFiles && currentRootItems.length === 0" class="px-3 py-6 text-center text-small text-text-subtle">工作区为空</div>
    </div>

    <div v-else class="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
      <button
        v-for="file in storedFileList"
        :key="file.fileId"
        class="list-row flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
        :class="{ 'is-selected': selectedStoredFile?.fileId === file.fileId }"
        @click="selectStoredFile(file)"
      >
        <div class="min-w-0">
          <div class="truncate text-ui text-text-secondary">{{ file.sourceName || file.fileRef || file.fileId }}</div>
          <div class="truncate font-mono text-small text-text-subtle">{{ file.fileRef }}</div>
        </div>
        <span class="shrink-0 rounded-full bg-surface-muted px-1.5 text-small text-text-subtle">{{ file.kind }}</span>
      </button>
      <div v-if="!loadingAssets && storedFileList.length === 0" class="px-3 py-6 text-center text-small text-text-subtle">暂无已保存文件</div>
    </div>
  </div>
</template>
