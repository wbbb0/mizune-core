<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { RefreshCw } from "lucide-vue-next";
import { sessionsApi } from "@/api/sessions";
import type { SessionDetailResult } from "@/api/types";
import type { ActiveSession } from "@/stores/sessions";
import { ApiError } from "@/api/client";
import ScenarioHostStateEditor from "./ScenarioHostStateEditor.vue";
import { WorkbenchAreaHeader, WorkbenchCard, WorkbenchDisclosure, WorkbenchEmptyState } from "@/components/workbench/primitives";

const props = defineProps<{
  session: ActiveSession;
}>();

const detail = ref<SessionDetailResult | null>(null);
const loading = ref(false);
const errorMessage = ref("");
const disclosureStates = reactive<Record<string, boolean>>({});

watch(() => [props.session.id, props.session.modeId] as const, () => {
  void loadDetail();
}, { immediate: true });

const sessionTitle = computed(() => detail.value?.session.title ?? props.session.title ?? "未设置");
const participantKindLabel = computed(() => props.session.participantRef.kind === "group" ? "群聊" : "用户");
const participantIdLabel = computed(() => props.session.participantRef.id || "未设置");

const commonFields = computed(() => [
  ["Session ID", props.session.id],
  ["来源", props.session.source],
  ["类型", props.session.type],
  ["模式", props.session.modeId],
  ["标题", sessionTitle.value],
  ["主体类型", participantKindLabel.value],
  ["主体 ID", participantIdLabel.value],
  ["连接状态", props.session.streamStatus],
  ["当前阶段", props.session.phase.label],
  ["消息计数", String(props.session.transcriptCount)],
  ["最后活跃", formatTimestamp(props.session.lastActiveAt)],
  ["historyRevision", detail.value ? String(detail.value.session.historyRevision) : "载入中"],
  ["mutationEpoch", detail.value ? String(detail.value.session.mutationEpoch) : "载入中"]
]);

function formatTimestamp(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return "暂无";
  }
  return new Date(value).toLocaleString();
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function isDisclosureExpanded(id: string): boolean {
  return disclosureStates[id] === true;
}

function toggleDisclosure(id: string): void {
  disclosureStates[id] = !isDisclosureExpanded(id);
}

function formatObservationLabel(purpose: string): string {
  if (purpose === "tool_replay_compaction") return "工具结果压缩";
  if (purpose === "image_caption") return "图片描述";
  if (purpose === "audio_transcription") return "音频听写";
  if (purpose === "session_title") return "会话标题";
  if (purpose === "history_summary") return "历史摘要";
  return purpose;
}

async function loadDetail() {
  loading.value = true;
  errorMessage.value = "";
  try {
    detail.value = await sessionsApi.fetchDetail(props.session.id);
  } catch (error: unknown) {
    errorMessage.value = error instanceof ApiError || error instanceof Error
      ? error.message
      : "载入会话状态失败";
  } finally {
    loading.value = false;
  }
}

function onScenarioHostSaved(state: NonNullable<SessionDetailResult["modeState"]>["state"]) {
  if (!detail.value) {
    return;
  }
  detail.value = {
    ...detail.value,
    modeState: {
      kind: "scenario_host",
      state
    }
  };
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
    <WorkbenchAreaHeader class="justify-between px-3 py-1" :uppercase="false">
      <span class="text-small text-text-subtle">查看并管理当前会话的非消息状态</span>
      <button
        class="btn-ghost flex items-center gap-1 px-1.5 py-0.5 text-small text-text-muted hover:text-text-primary"
        :disabled="loading"
        title="重新加载会话状态"
        @click="loadDetail"
      >
        <RefreshCw :size="12" :stroke-width="2" :class="{ spin: loading }" />
        重新加载
      </button>
    </WorkbenchAreaHeader>

    <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      <div class="flex flex-col gap-4">
        <div
          v-if="errorMessage"
          class="rounded border border-[color-mix(in_srgb,var(--danger)_55%,transparent)] bg-surface-danger px-3 py-2 text-small text-danger"
        >
          {{ errorMessage }}
        </div>

        <WorkbenchDisclosure
          :expanded="isDisclosureExpanded('overview')"
          collapsed-title="会话概览"
          expanded-title="会话概览"
          :summary="sessionTitle"
          @toggle="toggleDisclosure('overview')"
        >
          <WorkbenchCard surface="sidebar">
            <div class="text-small text-text-subtle">标题</div>
            <div class="mt-1 break-all text-ui text-text-secondary">{{ sessionTitle }}</div>
            <div class="mt-1 text-small text-text-subtle">
              {{ detail?.session.titleSource === 'manual' ? '手动设置' : detail?.session.titleSource === 'auto' ? '自动生成' : '默认标题' }}
            </div>
          </WorkbenchCard>
          <div class="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <WorkbenchCard v-for="[label, value] in commonFields" :key="label" surface="sidebar">
              <div class="text-small text-text-subtle">{{ label }}</div>
              <div class="mt-1 break-all text-ui text-text-secondary">{{ value }}</div>
            </WorkbenchCard>
          </div>
        </WorkbenchDisclosure>

        <WorkbenchDisclosure
          :expanded="isDisclosureExpanded('history-summary')"
          collapsed-title="历史摘要"
          expanded-title="历史摘要"
          @toggle="toggleDisclosure('history-summary')"
        >
          <div v-if="loading && !detail" class="text-small text-text-subtle">加载中…</div>
          <pre v-else class="overflow-auto rounded-lg border border-border-default bg-surface-sidebar p-3 text-small leading-6 whitespace-pre-wrap wrap-break-word text-text-muted">{{ detail?.session.historySummary || "暂无摘要" }}</pre>
        </WorkbenchDisclosure>

        <WorkbenchDisclosure
          :expanded="isDisclosureExpanded('derived-observations')"
          collapsed-title="派生观察"
          expanded-title="派生观察"
          :summary="`${detail?.session.derivedObservations.length ?? 0} 项`"
          @toggle="toggleDisclosure('derived-observations')"
        >
          <WorkbenchEmptyState v-if="(detail?.session.derivedObservations.length ?? 0) === 0" :centered="false" class="rounded border border-dashed border-border-default px-3 py-3 text-small text-text-subtle" message="暂无派生观察" />
          <div v-else class="grid min-w-0 gap-3 lg:grid-cols-2">
            <WorkbenchCard v-for="(item, index) in detail?.session.derivedObservations ?? []" :key="`${item.sourceKind}-${item.sourceId}-${item.purpose}-${index}`" class="min-w-0 overflow-hidden" surface="sidebar">
              <div class="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <span class="min-w-0 break-all font-mono text-small text-text-secondary">{{ item.sourceKind }}:{{ item.sourceId }}</span>
                <span class="text-small" :class="item.status === 'failed' ? 'text-danger' : item.status === 'ready' ? 'text-success' : 'text-text-subtle'">{{ item.status }}</span>
              </div>
              <div class="mt-1 text-small text-text-subtle">{{ formatObservationLabel(item.purpose) }}</div>
              <div v-if="item.modelRef" class="mt-1 break-all text-small text-text-muted">modelRef: {{ item.modelRef }}</div>
              <div v-if="item.updatedAt" class="mt-1 text-small text-text-muted">updatedAt: {{ formatTimestamp(item.updatedAt) }}</div>
              <div v-if="item.sourceHash" class="mt-1 break-all font-mono text-small text-text-muted">hash: {{ item.sourceHash }}</div>
              <div v-if="item.error" class="mt-1 whitespace-pre-wrap wrap-break-word text-small text-danger">{{ item.error }}</div>
              <div v-if="item.text" class="mt-2 line-clamp-4 whitespace-pre-wrap wrap-break-word text-small text-text-muted">{{ item.text }}</div>
            </WorkbenchCard>
          </div>
        </WorkbenchDisclosure>

        <WorkbenchDisclosure
          :expanded="isDisclosureExpanded('runtime-debug')"
          collapsed-title="调试与运行数据"
          expanded-title="调试与运行数据"
          @toggle="toggleDisclosure('runtime-debug')"
        >
          <div class="grid gap-4 lg:grid-cols-2">
            <WorkbenchCard surface="sidebar">
              <div class="text-small text-text-subtle">Debug Control</div>
              <pre class="mt-2 overflow-auto text-small leading-6 whitespace-pre-wrap wrap-break-word text-text-muted">{{ formatJson(detail?.session.debugControl ?? { enabled: false, oncePending: false }) }}</pre>
            </WorkbenchCard>
            <WorkbenchCard surface="sidebar">
              <div class="text-small text-text-subtle">Last LLM Usage</div>
              <pre class="mt-2 overflow-auto text-small leading-6 whitespace-pre-wrap wrap-break-word text-text-muted">{{ formatJson(detail?.session.lastLlmUsage ?? null) }}</pre>
            </WorkbenchCard>
          </div>
        </WorkbenchDisclosure>

        <WorkbenchDisclosure
          :expanded="isDisclosureExpanded('recent-tool-events')"
          collapsed-title="最近工具事件"
          expanded-title="最近工具事件"
          :summary="`${detail?.session.recentToolEvents.length ?? 0} 项`"
          @toggle="toggleDisclosure('recent-tool-events')"
        >
          <WorkbenchEmptyState v-if="(detail?.session.recentToolEvents.length ?? 0) === 0" :centered="false" class="rounded border border-dashed border-border-default px-3 py-3 text-small text-text-subtle" message="暂无工具事件" />
          <div v-else class="flex flex-col gap-2">
            <WorkbenchCard v-for="(event, index) in detail?.session.recentToolEvents ?? []" :key="`${event.toolName}-${event.timestampMs}-${index}`" surface="sidebar">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="font-mono text-small text-text-secondary">{{ event.toolName }}</span>
                <span class="text-small text-text-subtle">{{ formatTimestamp(event.timestampMs) }}</span>
              </div>
              <div class="mt-1 whitespace-pre-wrap wrap-break-word text-small text-text-muted">参数：{{ event.argsSummary || "无" }}</div>
              <div class="mt-1 whitespace-pre-wrap wrap-break-word text-small text-text-muted">结果：{{ event.resultSummary || "无" }}</div>
              <div class="mt-1 text-small" :class="event.outcome === 'error' ? 'text-danger' : 'text-success'">{{ event.outcome }}</div>
            </WorkbenchCard>
          </div>
        </WorkbenchDisclosure>

        <WorkbenchDisclosure
          :expanded="isDisclosureExpanded('debug-markers')"
          collapsed-title="调试标记"
          expanded-title="调试标记"
          :summary="`${detail?.session.debugMarkers.length ?? 0} 项`"
          @toggle="toggleDisclosure('debug-markers')"
        >
          <WorkbenchEmptyState v-if="(detail?.session.debugMarkers.length ?? 0) === 0" :centered="false" class="rounded border border-dashed border-border-default px-3 py-3 text-small text-text-subtle" message="暂无调试标记" />
          <div v-else class="flex flex-col gap-2">
            <WorkbenchCard v-for="(marker, index) in detail?.session.debugMarkers ?? []" :key="`${marker.kind}-${marker.timestampMs}-${index}`" surface="sidebar">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="font-mono text-small text-text-secondary">{{ marker.kind }}</span>
                <span class="text-small text-text-subtle">{{ formatTimestamp(marker.timestampMs) }}</span>
              </div>
              <div v-if="marker.note" class="mt-1 whitespace-pre-wrap wrap-break-word text-small text-text-muted">{{ marker.note }}</div>
              <div v-if="marker.sentCount != null" class="mt-1 text-small text-text-muted">sentCount: {{ marker.sentCount }}</div>
            </WorkbenchCard>
          </div>
        </WorkbenchDisclosure>

        <WorkbenchDisclosure
          :expanded="isDisclosureExpanded('sent-messages')"
          collapsed-title="最近发送记录"
          expanded-title="最近发送记录"
          :summary="`${detail?.session.sentMessages.length ?? 0} 项`"
          @toggle="toggleDisclosure('sent-messages')"
        >
          <WorkbenchEmptyState v-if="(detail?.session.sentMessages.length ?? 0) === 0" :centered="false" class="rounded border border-dashed border-border-default px-3 py-3 text-small text-text-subtle" message="暂无发送记录" />
          <div v-else class="flex flex-col gap-2">
            <WorkbenchCard v-for="message in detail?.session.sentMessages ?? []" :key="`${message.messageId}-${message.sentAt}`" surface="sidebar">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="font-mono text-small text-text-secondary">messageId {{ message.messageId }}</span>
                <span class="text-small text-text-subtle">{{ formatTimestamp(message.sentAt) }}</span>
              </div>
              <div class="mt-1 whitespace-pre-wrap wrap-break-word text-small text-text-muted">{{ message.text || "空文本" }}</div>
            </WorkbenchCard>
          </div>
        </WorkbenchDisclosure>

        <ScenarioHostStateEditor
          v-if="detail?.modeState?.kind === 'scenario_host'"
          :session-id="session.id"
          :state="detail.modeState.state"
          @saved="onScenarioHostSaved"
        />

        <WorkbenchDisclosure
          v-else
          :expanded="isDisclosureExpanded('mode-state')"
          collapsed-title="模式专属状态"
          expanded-title="模式专属状态"
          @toggle="toggleDisclosure('mode-state')"
        >
          <WorkbenchEmptyState :centered="false" class="rounded border border-dashed border-border-default px-3 py-3 text-small text-text-subtle" message="当前模式暂无可管理的结构化状态。" />
        </WorkbenchDisclosure>
      </div>
    </div>
  </div>
</template>
