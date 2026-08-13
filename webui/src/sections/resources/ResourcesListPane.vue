<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, type Component } from "vue";
import { ChevronDown, ChevronRight, Download, Globe, Play, RefreshCw, SquareTerminal } from "lucide-vue-next";
import { ResizableDisclosureStack, WorkbenchAreaHeader, WorkbenchEmptyState, WorkbenchIconButton, WorkbenchListItem } from "@workbench-kit/vue";
import { useResourcesSection } from "@/composables/sections/useResourcesSection";
import type { DownloadTask } from "@/api/runtimeResources";

const {
  shellSessions,
  selectedShellId,
  downloadTasks,
  selectedDownloadId,
  loading,
  busy,
  error,
  refreshDownloads,
  refreshResources,
  selectShell,
  createShell,
  selectDownload,
  startDownload
} = useResourcesSection();

const command = ref("zsh");
const cwd = ref("");
const downloadUrl = ref("");
const downloadName = ref("");
const downloadConcurrency = ref(4);
const downloadProxy = ref<"auto" | "direct">("auto");
const runningCount = computed(() => shellSessions.value.filter((item) => item.status === "running").length);
const activeDownloadCount = computed(() => downloadTasks.value.filter((item) => item.status === "running" || item.status === "paused").length);
let downloadRefreshTimer: number | null = null;

type ResourceSectionId = "shell" | "browser" | "downloads";
type ResourceSection = {
  id: ResourceSectionId;
  title: string;
  meta: string;
  icon: Component;
  weight: number;
};

const resourceSections = computed<ResourceSection[]>(() => [
  {
    id: "shell",
    title: "Shell",
    meta: `${runningCount.value} 运行中`,
    icon: SquareTerminal,
    weight: 2.4
  },
  {
    id: "browser",
    title: "浏览器页面",
    meta: "待接入",
    icon: Globe,
    weight: 1
  },
  {
    id: "downloads",
    title: "下载任务",
    meta: `${activeDownloadCount.value} 活跃 · ${downloadTasks.value.length} 总计`,
    icon: Download,
    weight: 1
  }
]);

async function startShell() {
  await createShell({
    command: command.value,
    cwd: cwd.value
  });
}

async function submitDownload() {
  const url = downloadUrl.value.trim();
  if (!url) return;
  await startDownload({
    url,
    ...(downloadName.value.trim() ? { sourceName: downloadName.value.trim() } : {}),
    concurrency: Math.min(16, Math.max(1, Math.trunc(Number(downloadConcurrency.value) || 4))),
    proxy: downloadProxy.value
  });
  downloadUrl.value = "";
  downloadName.value = "";
}

function shellMeta(session: { status: string; pid: number | null; cwd: string }) {
  const status = session.status === "running" ? "运行中" : "已关闭";
  return `${status}${session.pid ? ` · pid ${session.pid}` : ""} · ${session.cwd}`;
}

function downloadMeta(task: DownloadTask) {
  const status = {
    running: "下载中",
    paused: "已暂停",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消"
  }[task.status];
  const progress = task.percent != null ? `${task.percent}%` : formatBytes(task.downloaded_bytes);
  return `${status} · ${progress}`;
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(1)} GiB`;
}

onMounted(() => {
  downloadRefreshTimer = window.setInterval(() => {
    if (downloadTasks.value.some((item) => item.status === "running")) void refreshDownloads();
  }, 1000);
});

onBeforeUnmount(() => {
  if (downloadRefreshTimer != null) window.clearInterval(downloadRefreshTimer);
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-surface">
    <WorkbenchAreaHeader title="运行时资源">
      <template #actions>
        <WorkbenchIconButton :icon="RefreshCw" :disabled="loading" title="刷新" @click="refreshResources" />
      </template>
    </WorkbenchAreaHeader>

    <ResizableDisclosureStack :sections="resourceSections">
      <template #header="{ section, expanded }">
        <component :is="expanded ? ChevronDown : ChevronRight" :size="14" :stroke-width="2" class="shrink-0 text-text-muted" />
        <component :is="section.icon" :size="14" :stroke-width="2" class="shrink-0 text-text-muted" />
        <span class="min-w-0 flex-1 truncate">{{ section.title }}</span>
        <span class="shrink-0 text-text-subtle">{{ section.meta }}</span>
      </template>

      <template #default="{ section }">
        <div v-if="section.id === 'shell'" class="flex h-full min-h-0 flex-col">
          <div class="border-b border-border-subtle px-3 py-3">
            <div class="grid gap-2">
              <input v-model="command" class="input-base h-8 font-mono text-small" placeholder="zsh" :disabled="busy" @keydown.enter.prevent="startShell">
              <input v-model="cwd" class="input-base h-8 font-mono text-small" placeholder="cwd 默认" :disabled="busy" @keydown.enter.prevent="startShell">
              <button class="btn btn-primary h-8 justify-center gap-1.5" :disabled="busy" @click="startShell">
                <Play :size="13" :stroke-width="2" />
                <span>新建终端</span>
              </button>
            </div>
          </div>

          <div class="scrollbar-thin min-h-0 flex-1 overflow-y-auto py-2">
            <div class="space-y-1 px-2">
              <WorkbenchListItem
                v-for="session in shellSessions"
                :key="session.id"
                :selected="selectedShellId === session.id"
                :title="session.command"
                :meta="shellMeta(session)"
                @select="selectShell(session.id)"
              >
                <template #icon>
                  <SquareTerminal :size="15" :stroke-width="2" />
                </template>
              </WorkbenchListItem>
            </div>

            <WorkbenchEmptyState
              v-if="shellSessions.length === 0 && !loading"
              :centered="false"
              class="justify-center px-3 py-6 text-center text-small text-text-subtle"
              message="暂无 Shell 资源"
            />
          </div>
        </div>

        <WorkbenchEmptyState
          v-else-if="section.id === 'browser'"
          :centered="false"
          class="h-full justify-center px-3 py-6 text-center text-small text-text-subtle"
          message="浏览器页面待接入"
        />

        <div v-else class="flex h-full min-h-0 flex-col">
          <div class="border-b border-border-subtle px-3 py-3">
            <div class="grid gap-2">
              <input v-model="downloadUrl" class="input-base h-8 text-small" placeholder="https://example.com/file.zip" :disabled="busy" @keydown.enter.prevent="submitDownload">
              <input v-model="downloadName" class="input-base h-8 text-small" placeholder="文件名（可选）" :disabled="busy" @keydown.enter.prevent="submitDownload">
              <div class="grid grid-cols-[1fr_1fr] gap-2">
                <label class="grid gap-1 text-small text-text-subtle">
                  <span>并发分段</span>
                  <input v-model.number="downloadConcurrency" type="number" min="1" max="16" class="input-base h-8" :disabled="busy">
                </label>
                <label class="grid gap-1 text-small text-text-subtle">
                  <span>网络</span>
                  <select v-model="downloadProxy" class="input-base h-8" :disabled="busy">
                    <option value="auto">自动代理</option>
                    <option value="direct">直连</option>
                  </select>
                </label>
              </div>
              <button class="btn btn-primary h-8 justify-center gap-1.5" :disabled="busy || !downloadUrl.trim()" @click="submitDownload">
                <Download :size="13" :stroke-width="2" />
                <span>新建下载</span>
              </button>
            </div>
          </div>

          <div class="scrollbar-thin min-h-0 flex-1 overflow-y-auto py-2">
            <div class="space-y-1 px-2">
              <WorkbenchListItem
                v-for="task in downloadTasks"
                :key="task.resource_id"
                :selected="selectedDownloadId === task.resource_id"
                :title="task.source_name || task.source_url"
                :meta="downloadMeta(task)"
                @select="selectDownload(task.resource_id)"
              >
                <template #icon>
                  <Download :size="15" :stroke-width="2" />
                </template>
              </WorkbenchListItem>
            </div>
            <WorkbenchEmptyState
              v-if="downloadTasks.length === 0 && !loading"
              :centered="false"
              class="justify-center px-3 py-6 text-center text-small text-text-subtle"
              message="暂无下载任务"
            />
          </div>
        </div>
      </template>
    </ResizableDisclosureStack>

    <div v-if="error" class="mx-3 mt-3 rounded border border-danger/30 bg-danger/5 px-2 py-1.5 text-small text-danger">
      {{ error }}
    </div>
  </div>
</template>
