<script setup lang="ts">
import { computed, ref, type Component } from "vue";
import { ChevronDown, ChevronRight, Download, Globe, Play, RefreshCw, SquareTerminal } from "lucide-vue-next";
import { ResizableDisclosureStack, WorkbenchAreaHeader, WorkbenchEmptyState, WorkbenchIconButton, WorkbenchListItem } from "@workbench-kit/vue-workbench";
import { useResourcesSection } from "@/composables/sections/useResourcesSection";

const {
  shellSessions,
  selectedShellId,
  loading,
  busy,
  error,
  refreshShells,
  selectShell,
  createShell
} = useResourcesSection();

const command = ref("zsh");
const cwd = ref("");
const runningCount = computed(() => shellSessions.value.filter((item) => item.status === "running").length);

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
    meta: "待接入",
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

function shellMeta(session: { status: string; pid: number | null; cwd: string }) {
  const status = session.status === "running" ? "运行中" : "已关闭";
  return `${status}${session.pid ? ` · pid ${session.pid}` : ""} · ${session.cwd}`;
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-surface">
    <WorkbenchAreaHeader title="运行时资源">
      <template #actions>
        <WorkbenchIconButton :icon="RefreshCw" :disabled="loading" title="刷新" @click="refreshShells" />
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

        <WorkbenchEmptyState
          v-else
          :centered="false"
          class="h-full justify-center px-3 py-6 text-center text-small text-text-subtle"
          message="下载任务待接入"
        />
      </template>
    </ResizableDisclosureStack>

    <div v-if="error" class="mx-3 mt-3 rounded border border-danger/30 bg-danger/5 px-2 py-1.5 text-small text-danger">
      {{ error }}
    </div>
  </div>
</template>
