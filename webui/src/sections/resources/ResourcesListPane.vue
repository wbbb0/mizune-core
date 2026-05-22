<script setup lang="ts">
import { computed, ref } from "vue";
import { Play, RefreshCw, SquareTerminal } from "lucide-vue-next";
import { WorkbenchAreaHeader, WorkbenchEmptyState, WorkbenchListItem } from "@workbench-kit/vue-workbench";
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
        <button class="btn-ghost" :disabled="loading" title="刷新" @click="refreshShells">
          <RefreshCw :size="14" :stroke-width="2" />
        </button>
      </template>
    </WorkbenchAreaHeader>

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
      <div class="px-3 pb-2 text-small text-text-subtle">Shell · {{ runningCount }} 运行中</div>
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

      <div class="mt-4 border-t border-border-subtle px-3 pt-3">
        <div class="text-small font-medium text-text-secondary">浏览器页面</div>
        <div class="mt-1 text-small text-text-subtle">待接入</div>
      </div>
      <div class="mt-3 border-t border-border-subtle px-3 pt-3">
        <div class="text-small font-medium text-text-secondary">下载任务</div>
        <div class="mt-1 text-small text-text-subtle">待接入</div>
      </div>

      <div v-if="error" class="mx-3 mt-3 rounded border border-danger/30 bg-danger/5 px-2 py-1.5 text-small text-danger">
        {{ error }}
      </div>
    </div>
  </div>
</template>
