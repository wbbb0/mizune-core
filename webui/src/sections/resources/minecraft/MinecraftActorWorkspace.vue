<script setup lang="ts">
import { computed, ref } from "vue";
import { AlertOctagon, CircleStop, RefreshCw, Unplug } from "lucide-vue-next";
import { WorkbenchAreaHeader, WorkbenchEmptyState, WorkbenchIconButton } from "@workbench-kit/vue";
import { useMinecraftActors } from "@/composables/sections/useMinecraftActors";
import MinecraftActorRequestComposer from "./MinecraftActorRequestComposer.vue";
import MinecraftActorOverview from "./MinecraftActorOverview.vue";
import MinecraftActorTimeline from "./MinecraftActorTimeline.vue";
import MinecraftActorTasks from "./MinecraftActorTasks.vue";
import MinecraftActorPerception from "./MinecraftActorPerception.vue";
import MinecraftActorProgramSettings from "./MinecraftActorProgramSettings.vue";

const {
  activeActor,
  busy,
  error,
  streamStatus,
  refreshActors,
  refreshActorDetail,
  submitRequest,
  interrupt,
  closeActor
} = useMinecraftActors();

type ActorTab = "overview" | "timeline" | "tasks" | "perception" | "program";
const activeTab = ref<ActorTab>("overview");
const tabs: Array<{ id: ActorTab; label: string }> = [
  { id: "overview", label: "概览" },
  { id: "timeline", label: "动态" },
  { id: "tasks", label: "任务" },
  { id: "perception", label: "感知" },
  { id: "program", label: "程序与设置" }
];

const title = computed(() => activeActor.value?.title || activeActor.value?.actorId || "Minecraft Actor");

function phaseLabel(phase: string) {
  return ({ idle: "空闲", queued: "等待决策", deciding: "决策中", paused: "已暂停", error: "异常", closed: "已关闭", unavailable: "状态未知" } as Record<string, string>)[phase] ?? phase;
}

async function refreshCurrent() {
  const resourceId = activeActor.value?.resourceId;
  await refreshActors();
  if (resourceId) await refreshActorDetail(resourceId);
}

async function confirmClose() {
  if (!activeActor.value || !window.confirm(`关闭 ${title.value}？未完成的委派会被取消。`)) return;
  await closeActor();
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-surface">
    <WorkbenchAreaHeader :title="title">
      <template #actions>
        <WorkbenchIconButton :icon="RefreshCw" :disabled="busy" title="刷新" @click="refreshCurrent" />
        <WorkbenchIconButton
          :icon="CircleStop"
          :disabled="busy || !activeActor?.capabilities.canInterrupt"
          title="打断当前模型决策"
          @click="interrupt()"
        />
        <WorkbenchIconButton
          :icon="AlertOctagon"
          disabled
          title="立即停手将在独立安全 RPC 接入后开放"
        />
        <WorkbenchIconButton
          :icon="Unplug"
          :disabled="busy || !activeActor?.capabilities.canClose"
          title="关闭 Actor 资源"
          @click="confirmClose"
        />
      </template>
    </WorkbenchAreaHeader>

    <WorkbenchEmptyState v-if="!activeActor" centered message="请选择一个 Minecraft Actor" />

    <template v-else>
      <div class="border-b border-border-subtle px-4 py-3">
        <div class="flex flex-wrap items-center gap-2 text-caption">
          <span class="rounded-full border border-border-subtle px-2 py-0.5 text-text-muted">{{ phaseLabel(activeActor.loopPhase) }}</span>
          <span :class="streamStatus === 'connected' ? 'text-success' : streamStatus === 'error' ? 'text-danger' : 'text-warning'">
            {{ streamStatus === "connected" ? "SSE 已连接" : streamStatus === "error" ? "SSE 重连中" : streamStatus === "connecting" ? "SSE 连接中" : "SSE 已结束" }}
          </span>
          <span class="text-text-subtle">revision {{ activeActor.revision }}</span>
          <span v-if="activeActor.runtimeSnapshot" :class="activeActor.runtimeSnapshot.self.connected ? 'text-success' : 'text-danger'">
            {{ activeActor.runtimeSnapshot.self.connected ? "游戏已连接" : "游戏已断开" }}
          </span>
        </div>
        <div v-if="error" class="mt-2 rounded border border-danger/30 bg-danger/5 px-3 py-2 text-small text-danger">{{ error }}</div>
      </div>

      <div class="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <div class="mx-auto w-full max-w-6xl space-y-4 p-4">
          <MinecraftActorRequestComposer
            :disabled="busy || !activeActor.capabilities.canRequest"
            @submit="submitRequest"
          />

          <nav class="flex gap-1 overflow-x-auto border-b border-border-subtle" aria-label="Actor 详情">
            <button
              v-for="tab in tabs"
              :key="tab.id"
              class="shrink-0 border-b-2 px-3 py-2 text-small transition-colors"
              :class="activeTab === tab.id ? 'border-accent text-text' : 'border-transparent text-text-muted hover:text-text'"
              @click="activeTab = tab.id"
            >
              {{ tab.label }}
            </button>
          </nav>

          <MinecraftActorOverview v-if="activeTab === 'overview'" :actor="activeActor" />
          <MinecraftActorTimeline v-else-if="activeTab === 'timeline'" :events="activeActor.timeline" />
          <MinecraftActorTasks v-else-if="activeTab === 'tasks'" :requests="activeActor.requests" />
          <MinecraftActorPerception v-else-if="activeTab === 'perception'" :actor="activeActor" />
          <MinecraftActorProgramSettings v-else :actor="activeActor" />
        </div>
      </div>
    </template>
  </div>
</template>
