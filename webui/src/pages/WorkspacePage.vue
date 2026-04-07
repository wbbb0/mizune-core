<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RefreshCw, FolderOpen, Image as ImageIcon, FileText, File, Folder } from "lucide-vue-next";
import AppLayout from "@/components/layout/AppLayout.vue";
import WorkspaceFileTree from "@/components/workspace/WorkspaceFileTree.vue";
import ImagePreviewDialog from "@/components/common/ImagePreviewDialog.vue";
import { workspaceApi, type WorkspaceAssetSummary, type WorkspaceFilePreview, type WorkspaceItem } from "@/api/workspace";

type Mode = "files" | "assets";

const layout = ref<InstanceType<typeof AppLayout> | null>(null);
const mode = ref<Mode>("files");
const loadingFiles = ref(false);
const loadingAssets = ref(false);
const itemsByPath = ref<Record<string, WorkspaceItem[]>>({});
const expandedPaths = ref<string[]>([]);
const selectedPath = ref<string | null>(null);
const selectedItem = ref<WorkspaceItem | null>(null);
const selectedAsset = ref<WorkspaceAssetSummary | null>(null);
const assetList = ref<WorkspaceAssetSummary[]>([]);
const filePreview = ref<WorkspaceFilePreview | null>(null);
const previewError = ref<string | null>(null);
const fileImageSrc = ref<string | null>(null);
const dialogImageSrc = ref<string | null>(null);

const currentRootItems = computed(() => itemsByPath.value["."] ?? []);
const mobileHeaderTitle = computed(() =>
  selectedItem.value?.name ?? selectedAsset.value?.filename ?? selectedAsset.value?.assetId ?? "工作区"
);
const selectedAssetImageUrl = computed(() =>
  selectedAsset.value ? workspaceApi.getAssetContentUrl(selectedAsset.value.assetId) : null
);

onMounted(async () => {
  await Promise.all([loadDirectory("."), loadAssets()]);
});

async function loadDirectory(path: string): Promise<void> {
  loadingFiles.value = true;
  try {
    const result = await workspaceApi.listItems(path);
    itemsByPath.value = {
      ...itemsByPath.value,
      [path]: result.items
    };
  } finally {
    loadingFiles.value = false;
  }
}

async function loadAssets(): Promise<void> {
  loadingAssets.value = true;
  try {
    const result = await workspaceApi.listAssets();
    assetList.value = result.assets;
  } finally {
    loadingAssets.value = false;
  }
}

async function toggleDirectory(path: string) {
  const next = new Set(expandedPaths.value);
  if (next.has(path)) {
    next.delete(path);
  } else {
    next.add(path);
    if (!itemsByPath.value[path]) {
      await loadDirectory(path);
    }
  }
  expandedPaths.value = [...next];
}

async function selectItem(item: WorkspaceItem) {
  selectedPath.value = item.path;
  selectedItem.value = item;
  selectedAsset.value = null;
  filePreview.value = null;
  previewError.value = null;
  fileImageSrc.value = null;
  dialogImageSrc.value = null;

  if (item.kind === "directory") {
    if (!expandedPaths.value.includes(item.path)) {
      await toggleDirectory(item.path);
    }
    layout.value?.openDetail();
    return;
  }

  if (isImageFile(item.name)) {
    fileImageSrc.value = workspaceApi.getFileContentUrl(item.path);
    layout.value?.openDetail();
    return;
  }

  try {
    filePreview.value = await workspaceApi.readFile(item.path, { startLine: 1, endLine: 240 });
  } catch (error: unknown) {
    previewError.value = error instanceof Error ? error.message : "暂不支持预览该文件";
  }
  layout.value?.openDetail();
}

function selectAsset(asset: WorkspaceAssetSummary) {
  selectedAsset.value = asset;
  selectedItem.value = null;
  selectedPath.value = null;
  filePreview.value = null;
  previewError.value = null;
  fileImageSrc.value = null;
  dialogImageSrc.value = null;
  layout.value?.openDetail();
}

function refreshCurrentMode() {
  if (mode.value === "files") {
    void loadDirectory(".");
  } else {
    void loadAssets();
  }
}

function previewIcon(item: WorkspaceItem | null) {
  if (!item) return FolderOpen;
  if (item.kind === "directory") return Folder;
  if (isImageFile(item.name)) return ImageIcon;
  if (/\.(txt|md|json|ya?ml|log|ts|tsx|js|jsx|vue|css|html)$/i.test(item.name)) return FileText;
  return File;
}

function isImageFile(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(name);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString("zh-CN");
}
</script>

<template>
  <AppLayout ref="layout">
    <template #side>
      <div class="panel-header flex h-10 shrink-0 items-center justify-between border-b px-3">
        <div class="inline-flex rounded-md border border-border-default bg-surface-input p-0.5">
          <button class="px-2 py-0.75 text-small" :class="mode === 'files' ? 'rounded bg-surface-selected-muted text-text-secondary' : 'text-text-muted'" @click="mode = 'files'">文件</button>
          <button class="px-2 py-0.75 text-small" :class="mode === 'assets' ? 'rounded bg-surface-selected-muted text-text-secondary' : 'text-text-muted'" @click="mode = 'assets'">资产</button>
        </div>
        <button class="btn-ghost" :disabled="loadingFiles || loadingAssets" title="刷新" @click="refreshCurrentMode">
          <RefreshCw :size="14" :stroke-width="2" :class="{ spin: loadingFiles || loadingAssets }" />
        </button>
      </div>

      <div v-if="mode === 'files'" class="scrollbar-thin overflow-y-auto px-2 py-2">
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

      <div v-else class="scrollbar-thin overflow-y-auto">
        <button
          v-for="asset in assetList"
          :key="asset.assetId"
          class="list-row flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
          :class="{ 'is-selected': selectedAsset?.assetId === asset.assetId }"
          @click="selectAsset(asset)"
        >
          <div class="min-w-0">
            <div class="truncate text-ui text-text-secondary">{{ asset.filename || asset.assetId }}</div>
            <div class="truncate font-mono text-small text-text-subtle">{{ asset.assetId }}</div>
          </div>
          <span class="shrink-0 rounded-full bg-surface-muted px-1.5 text-small text-text-subtle">{{ asset.kind }}</span>
        </button>
        <div v-if="!loadingAssets && assetList.length === 0" class="px-3 py-6 text-center text-small text-text-subtle">暂无资产</div>
      </div>
    </template>

    <template #main>
      <div class="flex h-full flex-col overflow-hidden">
        <div v-if="mode === 'files'" class="flex h-full flex-col overflow-hidden">
          <div v-if="!selectedItem" class="panel-empty flex flex-1 items-center justify-center gap-2">← 选择一个文件或目录</div>
          <template v-else>
            <header class="toolbar-header flex shrink-0 items-center h-10 gap-3 border-b px-4 py-2">
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
              <button class="cursor-zoom-in overflow-hidden rounded-lg border border-border-default bg-surface-sidebar p-2" @click="dialogImageSrc = fileImageSrc">
                <img :src="fileImageSrc" :alt="selectedItem.name" class="max-h-[70vh] max-w-full rounded object-contain" />
              </button>
            </div>
            <pre v-else-if="filePreview" class="scrollbar-thin m-0 flex-1 overflow-auto px-4 py-3 font-mono text-mono leading-6 text-text-primary whitespace-pre-wrap">{{ filePreview.content }}</pre>
            <div v-else class="panel-empty flex flex-1 items-center justify-center gap-2">
              <RefreshCw :size="14" :stroke-width="2" class="spin" />
            </div>
          </template>
        </div>

        <div v-else class="flex h-full flex-col overflow-hidden">
          <div v-if="!selectedAsset" class="panel-empty flex flex-1 items-center justify-center gap-2">← 选择一个资产</div>
          <template v-else>
            <header class="toolbar-header flex shrink-0 items-center gap-3 border-b px-4 py-2">
              <span class="min-w-0 flex-1 truncate font-mono text-small text-text-muted">{{ selectedAsset.storagePath }}</span>
              <span class="shrink-0 text-small text-text-subtle">{{ formatSize(selectedAsset.sizeBytes) }}</span>
              <span class="shrink-0 text-small text-text-subtle">{{ formatTime(selectedAsset.createdAtMs) }}</span>
            </header>

            <div class="scrollbar-thin flex-1 overflow-auto px-4 py-4">
              <div v-if="selectedAsset.kind === 'image' || selectedAsset.kind === 'animated_image'" class="mb-4">
                <button class="cursor-zoom-in overflow-hidden rounded-lg border border-border-default bg-surface-sidebar p-2" @click="selectedAssetImageUrl ? dialogImageSrc = selectedAssetImageUrl : null">
                  <img v-if="selectedAssetImageUrl" :src="selectedAssetImageUrl" :alt="selectedAsset.filename || selectedAsset.assetId" class="max-h-[65vh] w-full rounded object-contain" />
                </button>
              </div>
              <div v-else class="mb-4 rounded-lg border border-border-default bg-surface-sidebar px-4 py-3 text-text-muted">
                当前只支持图片直接预览，该资产将展示元数据。
              </div>

              <dl class="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-2 text-ui">
                <dt class="text-text-subtle">assetId</dt>
                <dd class="min-w-0 font-mono text-text-secondary">{{ selectedAsset.assetId }}</dd>
                <dt class="text-text-subtle">文件名</dt>
                <dd class="min-w-0 text-text-secondary">{{ selectedAsset.filename }}</dd>
                <dt class="text-text-subtle">类型</dt>
                <dd class="text-text-secondary">{{ selectedAsset.kind }}</dd>
                <dt class="text-text-subtle">MIME</dt>
                <dd class="font-mono text-text-secondary">{{ selectedAsset.mimeType }}</dd>
                <dt class="text-text-subtle">来源</dt>
                <dd class="text-text-secondary">{{ selectedAsset.origin }}</dd>
                <dt class="text-text-subtle">路径</dt>
                <dd class="min-w-0 font-mono text-text-secondary">{{ selectedAsset.storagePath }}</dd>
                <dt class="text-text-subtle">Caption</dt>
                <dd class="text-text-secondary">{{ selectedAsset.caption || "无" }}</dd>
              </dl>
            </div>
          </template>
        </div>
      </div>
    </template>

    <template #mobile-header>
      <span class="truncate text-ui font-medium text-text-secondary">{{ mobileHeaderTitle }}</span>
    </template>
  </AppLayout>

  <ImagePreviewDialog
    :open="dialogImageSrc !== null"
    :src="dialogImageSrc || ''"
    :title="selectedAsset?.filename || selectedAsset?.assetId || selectedItem?.name"
    @close="dialogImageSrc = null"
  />
</template>
