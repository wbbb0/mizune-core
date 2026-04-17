<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { RefreshCw } from "lucide-vue-next";
import { sessionsApi } from "@/api/sessions";
import type { SessionDetailResult } from "@/api/types";
import type { ActiveSession } from "@/stores/sessions";
import { ApiError } from "@/api/client";
import ScenarioHostStateEditor from "./ScenarioHostStateEditor.vue";

const props = defineProps<{
  session: ActiveSession;
}>();

const session = computed(() => props.session);
const detail = ref<SessionDetailResult | null>(null);
const loading = ref(false);
const errorMessage = ref("");

watch(() => [props.session.id, props.session.modeId] as const, () => {
  void loadDetail();
}, { immediate: true });

const commonFields = computed(() => [
  ["Session ID", props.session.id],
  ["来源", props.session.source],
  ["类型", props.session.type],
  ["模式", props.session.modeId],
  ["参与者 ID", props.session.participantUserId],
  ["参与者名称", props.session.participantLabel ?? "未设置"],
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
    <div class="sticky-toolbar flex shrink-0 items-center justify-between border-b px-3 py-1">
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
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      <div class="flex flex-col gap-4">
        <div
          v-if="errorMessage"
          class="rounded border border-[color:color-mix(in_srgb,var(--danger)_55%,transparent)] bg-surface-danger px-3 py-2 text-small text-danger"
        >
          {{ errorMessage }}
        </div>

        <section class="rounded-lg border border-border-default bg-surface-panel p-4">
          <div class="text-ui font-medium text-text-secondary">会话概览</div>
          <div class="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <div v-for="[label, value] in commonFields" :key="label" class="rounded-lg border border-border-default bg-surface-sidebar px-3 py-2">
              <div class="text-small text-text-subtle">{{ label }}</div>
              <div class="mt-1 break-all text-ui text-text-secondary">{{ value }}</div>
            </div>
          </div>
        </section>

        <section class="rounded-lg border border-border-default bg-surface-panel p-4">
          <div class="text-ui font-medium text-text-secondary">历史摘要</div>
          <div v-if="loading && !detail" class="mt-3 text-small text-text-subtle">加载中…</div>
          <pre v-else class="mt-3 overflow-x-auto rounded-lg border border-border-default bg-surface-sidebar p-3 text-small leading-6 whitespace-pre-wrap text-text-muted">{{ detail?.session.historySummary || "暂无摘要" }}</pre>
        </section>

        <section class="rounded-lg border border-border-default bg-surface-panel p-4">
          <div class="text-ui font-medium text-text-secondary">调试与运行数据</div>
          <div class="mt-3 grid gap-4 lg:grid-cols-2">
            <div class="rounded-lg border border-border-default bg-surface-sidebar p-3">
              <div class="text-small text-text-subtle">Debug Control</div>
              <pre class="mt-2 overflow-x-auto text-small leading-6 whitespace-pre-wrap text-text-muted">{{ formatJson(detail?.session.debugControl ?? { enabled: false, oncePending: false }) }}</pre>
            </div>
            <div class="rounded-lg border border-border-default bg-surface-sidebar p-3">
              <div class="text-small text-text-subtle">Last LLM Usage</div>
              <pre class="mt-2 overflow-x-auto text-small leading-6 whitespace-pre-wrap text-text-muted">{{ formatJson(detail?.session.lastLlmUsage ?? null) }}</pre>
            </div>
          </div>
        </section>

        <section class="rounded-lg border border-border-default bg-surface-panel p-4">
          <div class="text-ui font-medium text-text-secondary">最近工具事件</div>
          <div v-if="(detail?.session.recentToolEvents.length ?? 0) === 0" class="mt-3 rounded border border-dashed border-border-default px-3 py-3 text-small text-text-subtle">
            暂无工具事件
          </div>
          <div v-else class="mt-3 flex flex-col gap-2">
            <div v-for="(event, index) in detail?.session.recentToolEvents ?? []" :key="`${event.toolName}-${event.timestampMs}-${index}`" class="rounded-lg border border-border-default bg-surface-sidebar px-3 py-2">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="font-mono text-small text-text-secondary">{{ event.toolName }}</span>
                <span class="text-small text-text-subtle">{{ formatTimestamp(event.timestampMs) }}</span>
              </div>
              <div class="mt-1 text-small text-text-muted">参数：{{ event.argsSummary || "无" }}</div>
              <div class="mt-1 text-small text-text-muted">结果：{{ event.resultSummary || "无" }}</div>
              <div class="mt-1 text-small" :class="event.outcome === 'error' ? 'text-danger' : 'text-success'">{{ event.outcome }}</div>
            </div>
          </div>
        </section>

        <section class="rounded-lg border border-border-default bg-surface-panel p-4">
          <div class="text-ui font-medium text-text-secondary">调试标记</div>
          <div v-if="(detail?.session.debugMarkers.length ?? 0) === 0" class="mt-3 rounded border border-dashed border-border-default px-3 py-3 text-small text-text-subtle">
            暂无调试标记
          </div>
          <div v-else class="mt-3 flex flex-col gap-2">
            <div v-for="(marker, index) in detail?.session.debugMarkers ?? []" :key="`${marker.kind}-${marker.timestampMs}-${index}`" class="rounded-lg border border-border-default bg-surface-sidebar px-3 py-2">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="font-mono text-small text-text-secondary">{{ marker.kind }}</span>
                <span class="text-small text-text-subtle">{{ formatTimestamp(marker.timestampMs) }}</span>
              </div>
              <div v-if="marker.note" class="mt-1 text-small text-text-muted">{{ marker.note }}</div>
              <div v-if="marker.sentCount != null" class="mt-1 text-small text-text-muted">sentCount: {{ marker.sentCount }}</div>
            </div>
          </div>
        </section>

        <section class="rounded-lg border border-border-default bg-surface-panel p-4">
          <div class="text-ui font-medium text-text-secondary">最近发送记录</div>
          <div v-if="(detail?.session.sentMessages.length ?? 0) === 0" class="mt-3 rounded border border-dashed border-border-default px-3 py-3 text-small text-text-subtle">
            暂无发送记录
          </div>
          <div v-else class="mt-3 flex flex-col gap-2">
            <div v-for="message in detail?.session.sentMessages ?? []" :key="`${message.messageId}-${message.sentAt}`" class="rounded-lg border border-border-default bg-surface-sidebar px-3 py-2">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="font-mono text-small text-text-secondary">messageId {{ message.messageId }}</span>
                <span class="text-small text-text-subtle">{{ formatTimestamp(message.sentAt) }}</span>
              </div>
              <div class="mt-1 text-small text-text-muted whitespace-pre-wrap">{{ message.text || "空文本" }}</div>
            </div>
          </div>
        </section>

        <ScenarioHostStateEditor
          v-if="detail?.modeState?.kind === 'scenario_host'"
          :session-id="session.id"
          :state="detail.modeState.state"
          @saved="onScenarioHostSaved"
        />

        <section v-else class="rounded-lg border border-border-default bg-surface-panel p-4">
          <div class="text-ui font-medium text-text-secondary">模式专属状态</div>
          <div class="mt-3 rounded border border-dashed border-border-default px-3 py-3 text-small text-text-subtle">
            当前模式暂无可管理的结构化状态。
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
