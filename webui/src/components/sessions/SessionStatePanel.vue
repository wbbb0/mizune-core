<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { RefreshCw } from "lucide-vue-next";
import { sessionsApi } from "@/api/sessions";
import type { MemoryContextItem, SessionDetailResult, SessionTaskTracker } from "@/api/types";
import type { ActiveSession } from "@/stores/sessions";
import { ApiError } from "@/api/client";
import ScenarioHostStateEditor from "./ScenarioHostStateEditor.vue";
import { WorkbenchAreaHeader, WorkbenchCard, WorkbenchDisclosure, WorkbenchEmptyState } from "@workbench-kit/vue";

const props = defineProps<{
  session: ActiveSession;
}>();

const detail = ref<SessionDetailResult | null>(null);
const loading = ref(false);
const errorMessage = ref("");
const disclosureStates = reactive<Record<string, boolean>>({});
let detailRequestSeq = 0;

watch(() => [props.session.id, props.session.modeId] as const, () => {
  detail.value = null;
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

const debugControlRows = computed(() => {
  const debugControl = detail.value?.session.debugControl ?? { enabled: false, oncePending: false };
  return [
    ["调试开关", debugControl.enabled ? "已开启" : "关闭"],
    ["单次调试", debugControl.oncePending ? "已等待触发" : "未启用"]
  ];
});

const lastLlmUsageRows = computed(() => {
  const usage = detail.value?.session.lastLlmUsage ?? null;
  if (!usage) {
    return [];
  }
  return [
    ["模型引用", usage.modelRef || "暂无"],
    ["模型", usage.model || "暂无"],
    ["输入 tokens", formatMetric(usage.inputTokens)],
    ["输出 tokens", formatMetric(usage.outputTokens)],
    ["总 tokens", formatMetric(usage.totalTokens)],
    ["缓存 tokens", formatMetric(usage.cachedTokens)],
    ["推理 tokens", formatMetric(usage.reasoningTokens)],
    ["请求数", formatMetric(usage.requestCount)],
    ["Provider 上报", usage.providerReported ? "是" : "否"],
    ["采集时间", formatTimestamp(usage.capturedAt)]
  ];
});

const taskTracker = computed<SessionTaskTracker | null>(() => detail.value?.session.taskTracker ?? null);
const recentTaskEvidence = computed(() => taskTracker.value?.evidence.slice(-5).reverse() ?? []);
const taskTrackerSummary = computed(() => {
  const tracker = taskTracker.value;
  if (!tracker) {
    return "暂无记录";
  }
  const primaryStatus = tracker.primary ? tracker.primary.status : "无当前任务";
  return `${primaryStatus} · parked ${tracker.parked.length} · evidence ${tracker.evidence.length}`;
});
const taskTrackerRows = computed(() => {
  const tracker = taskTracker.value;
  if (!tracker) {
    return [];
  }
  return [
    ["当前任务", tracker.primary ? tracker.primary.taskId : "暂无"],
    ["状态", tracker.primary ? tracker.primary.status : "暂无"],
    ["目标", tracker.primary?.objective || "暂无"],
    ["已完成数", formatMetric(tracker.primary?.done.length ?? 0)],
    ["下一步数", formatMetric(tracker.primary?.next.length ?? 0)],
    ["阻碍数", formatMetric(tracker.primary?.blockers.length ?? 0)],
    ["关键工具引用", formatMetric(tracker.primary?.importantToolRefs.length ?? 0)],
    ["Parked", formatMetric(tracker.parked.length)],
    ["Evidence", formatMetric(tracker.evidence.length)]
  ];
});

const memoryContext = computed(() => detail.value?.session.memoryContext ?? null);
const memoryContextSummary = computed(() => {
  const report = memoryContext.value;
  if (!report) {
    return "暂无记录";
  }
  const userLabel = report.userFactTruncated
    ? `用户 ${report.currentUserFactCount}/${report.availableUserFactCount}`
    : `用户 ${report.currentUserFactCount}`;
  const sessionLabel = report.sessionFactTruncated
    ? `会话 ${report.currentSessionFactCount}/${report.availableSessionFactCount}`
    : `会话 ${report.currentSessionFactCount}`;
  return `${report.selectedCount} 项 · ${userLabel} · ${sessionLabel} · 召回 ${report.retrievedUserContextCount}`;
});

const memoryContextOverviewRows = computed(() => {
  const report = memoryContext.value;
  if (!report) {
    return [];
  }
  return [
    ["记录时间", formatTimestamp(report.createdAt)],
    ["Session ID", report.sessionId],
    ["User ID", report.userId || "暂无"],
    ["模式", report.modeId || "暂无"],
    ["进入 prompt 总数", formatMetric(report.selectedCount)],
    ["用户固定记忆", formatFixedMemoryCount(report.currentUserFactCount, report.availableUserFactCount, report.userFactLimit, report.userFactTruncated)],
    ["会话记忆", formatFixedMemoryCount(report.currentSessionFactCount, report.availableSessionFactCount, report.sessionFactLimit, report.sessionFactTruncated)],
    ["语义召回", formatMetric(report.retrievedUserContextCount)]
  ];
});

const memoryRetrievalRows = computed(() => {
  const retrieval = memoryContext.value?.semanticRetrieval ?? null;
  if (!retrieval) {
    return [];
  }
  const rows: Array<[string, string]> = [
    ["语义召回", retrieval.attempted ? "已执行" : "未执行"]
  ];
  if (retrieval.skippedReason) {
    rows.push(["跳过原因", formatMemoryRetrievalSkipReason(retrieval.skippedReason)]);
  }
  if (retrieval.debugReport) {
    rows.push(
      ["候选数", formatMetric(retrieval.debugReport.candidateCount)],
      ["已索引", formatMetric(retrieval.debugReport.indexedCount)],
      ["选中数", formatMetric(retrieval.debugReport.selectedCount)],
      ["丢弃数", formatMetric(retrieval.debugReport.droppedCount)],
      ["Embedding Profile", retrieval.debugReport.embeddingProfileId || "暂无"],
      ["Debug 时间", formatTimestamp(retrieval.debugReport.createdAt)]
    );
    if (retrieval.debugReport.error) {
      rows.push(["错误", retrieval.debugReport.error]);
    }
  }
  return rows;
});

function formatTimestamp(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return "暂无";
  }
  return new Date(value).toLocaleString();
}

function formatMetric(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return "暂无";
  }
  return value.toLocaleString();
}

function formatFixedMemoryCount(
  selectedCount: number,
  availableCount: number,
  limit: number,
  truncated: boolean
): string {
  if (!truncated) {
    return formatMetric(selectedCount);
  }
  return `${formatMetric(selectedCount)} / ${formatMetric(availableCount)}，上限 ${formatMetric(limit)}，已截断`;
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

function formatSafetySubject(kind: string): string {
  if (kind === "text") return "文本";
  if (kind === "image") return "图片";
  if (kind === "emoji") return "表情";
  if (kind === "audio_transcript") return "音频";
  if (kind === "file") return "文件";
  if (kind === "local_media") return "本地媒体";
  return kind;
}

function formatSafetyLabels(labels: Array<{ label: string; riskLevel?: string; confidence?: number }>): string {
  if (labels.length === 0) {
    return "无标签";
  }
  return labels.map((item) => [
    item.label,
    item.riskLevel ? `risk=${item.riskLevel}` : null,
    item.confidence != null ? `confidence=${item.confidence}` : null
  ].filter(Boolean).join(" ")).join("，");
}

function formatMemoryEntrySource(source: MemoryContextItem["entrySource"]): string {
  if (source === "semantic_retrieval") return "语义召回";
  return source;
}

function formatMemoryRetrievalSkipReason(reason: string): string {
  if (reason === "scenario_host_mode") return "场景主持模式";
  if (reason === "assistant_mode") return "助手模式";
  if (reason === "missing_user") return "缺少当前用户";
  if (reason === "service_unavailable") return "召回服务不可用";
  return reason;
}

function formatMemoryItemMeta(item: MemoryContextItem): string {
  return [
    formatMemoryEntrySource(item.entrySource),
    item.scope,
    item.layer,
    item.subjectId ? `${item.subjectKind}:${item.subjectId}` : item.subjectKind,
    item.sourceType,
    item.kind,
    item.memorySource,
    item.score != null ? `score=${formatScore(item.score)}` : null,
    item.importance != null ? `importance=${item.importance}` : null,
    item.slotKey ? `slot=${item.slotKey}` : null,
    `updated=${formatTimestamp(item.updatedAt)}`
  ].filter(Boolean).join(" · ");
}

function formatTaskResource(resource: { kind: string; id: string } | undefined): string {
  return resource ? `${resource.kind}:${resource.id}` : "无资源";
}

function formatScore(value: number): string {
  if (!Number.isFinite(value)) {
    return "暂无";
  }
  return value.toFixed(3);
}

async function loadDetail() {
  const requestSeq = ++detailRequestSeq;
  const sessionId = props.session.id;
  loading.value = true;
  errorMessage.value = "";
  try {
    const loaded = await sessionsApi.fetchDetail(sessionId);
    if (requestSeq === detailRequestSeq && props.session.id === sessionId) {
      detail.value = loaded;
    }
  } catch (error: unknown) {
    if (requestSeq === detailRequestSeq && props.session.id === sessionId) {
      errorMessage.value = error instanceof ApiError || error instanceof Error
        ? error.message
        : "载入会话状态失败";
    }
  } finally {
    if (requestSeq === detailRequestSeq && props.session.id === sessionId) {
      loading.value = false;
    }
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
    <WorkbenchAreaHeader class="flex-wrap justify-between gap-2 px-3 py-1" :uppercase="false">
      <span class="min-w-0 text-small text-text-subtle">查看并管理当前会话的非消息状态</span>
      <button
        class="btn-ghost flex shrink-0 items-center gap-1 px-1.5 py-0.5 text-small text-text-muted hover:text-text-primary"
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
          <div class="border-b border-border-subtle pb-3">
            <div class="text-small text-text-subtle">标题</div>
            <div class="mt-1 break-all text-ui text-text-secondary">{{ sessionTitle }}</div>
            <div class="mt-1 text-small text-text-subtle">
              {{ detail?.session.titleSource === 'manual' ? '手动设置' : detail?.session.titleSource === 'auto' ? '自动生成' : '默认标题' }}
            </div>
          </div>
          <div class="mt-3 grid gap-x-5 gap-y-2 md:grid-cols-2">
            <div v-for="[label, value] in commonFields" :key="label" class="grid min-w-0 grid-cols-[6rem_minmax(0,1fr)] gap-3 border-b border-border-subtle py-1.5">
              <div class="text-small text-text-subtle">{{ label }}</div>
              <div class="break-all text-small text-text-secondary">{{ value }}</div>
            </div>
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
          :expanded="isDisclosureExpanded('task-tracker')"
          collapsed-title="任务跟踪"
          expanded-title="任务跟踪"
          :summary="taskTrackerSummary"
          @toggle="toggleDisclosure('task-tracker')"
        >
          <WorkbenchEmptyState v-if="!taskTracker" :centered="false" class="rounded border border-dashed border-border-default px-3 py-3 text-small text-text-subtle" message="暂无任务跟踪状态" />
          <div v-else class="flex min-w-0 flex-col gap-3">
            <div class="grid gap-x-5 gap-y-2 md:grid-cols-2">
              <div v-for="[label, value] in taskTrackerRows" :key="label" class="grid min-w-0 grid-cols-[6rem_minmax(0,1fr)] gap-3 border-b border-border-subtle py-1.5">
                <div class="text-small text-text-subtle">{{ label }}</div>
                <div class="break-all text-small text-text-secondary">{{ value }}</div>
              </div>
            </div>

            <section v-if="taskTracker.parked.length > 0" class="min-w-0">
              <div class="text-small text-text-subtle">Parked Tasks</div>
              <div class="mt-2 grid gap-1.5">
                <div v-for="task in taskTracker.parked" :key="task.taskId" class="border-l border-border-subtle pl-3 py-1">
                  <div class="flex min-w-0 flex-wrap items-center justify-between gap-2">
                    <span class="break-all font-mono text-small text-text-secondary">{{ task.taskId }}</span>
                    <span class="text-small text-text-subtle">{{ task.status }}</span>
                  </div>
                  <div class="mt-1 break-all text-small text-text-muted">{{ task.objective }}</div>
                  <div class="mt-1 break-all text-small text-text-subtle">{{ task.summary }}</div>
                </div>
              </div>
            </section>

            <section class="min-w-0">
              <div class="text-small text-text-subtle">最近 Evidence</div>
              <WorkbenchEmptyState v-if="recentTaskEvidence.length === 0" :centered="false" class="mt-2 rounded border border-dashed border-border-default px-3 py-3 text-small text-text-subtle" message="暂无 evidence checkpoint" />
              <div v-else class="mt-2 grid gap-1.5">
                <div v-for="item in recentTaskEvidence" :key="item.evidenceId" class="border-l border-border-subtle pl-3 py-1">
                  <div class="flex min-w-0 flex-wrap items-center justify-between gap-2">
                    <span class="break-all font-mono text-small text-text-secondary">{{ item.toolName }}#{{ item.toolCallId }}</span>
                    <span class="text-small" :class="item.pinned ? 'text-warning' : 'text-text-subtle'">{{ item.pinned ? 'pinned' : 'checkpoint' }}</span>
                  </div>
                  <div class="mt-1 break-all text-small text-text-subtle">task {{ item.taskId }} · {{ formatTaskResource(item.resource) }} · {{ formatTimestamp(item.createdAtMs) }}</div>
                  <div class="mt-1 line-clamp-3 whitespace-pre-wrap wrap-break-word text-small text-text-muted">{{ item.summary }}</div>
                  <div class="mt-1 break-all font-mono text-small text-text-subtle">hash {{ item.contentHash }}{{ item.canonicalTruncated ? ' · canonical truncated' : '' }}</div>
                </div>
              </div>
            </section>
          </div>
        </WorkbenchDisclosure>

        <WorkbenchDisclosure
          :expanded="isDisclosureExpanded('memory-context')"
          collapsed-title="最近记忆上下文"
          expanded-title="最近记忆上下文"
          :summary="memoryContextSummary"
          @toggle="toggleDisclosure('memory-context')"
        >
          <WorkbenchEmptyState v-if="!memoryContext" :centered="false" class="rounded border border-dashed border-border-default px-3 py-3 text-small text-text-subtle" message="暂无记忆上下文记录。下一次生成回复后会显示实际进入 prompt 的记忆。" />
          <div v-else class="flex min-w-0 flex-col gap-3">
            <div class="grid gap-x-5 gap-y-2 md:grid-cols-2">
              <div v-for="[label, value] in memoryContextOverviewRows" :key="label" class="grid min-w-0 grid-cols-[6rem_minmax(0,1fr)] gap-3 border-b border-border-subtle py-1.5">
                <div class="text-small text-text-subtle">{{ label }}</div>
                <div class="break-all text-small text-text-secondary">{{ value }}</div>
              </div>
            </div>

            <section class="min-w-0">
              <div class="text-small text-text-subtle">召回查询文本</div>
              <pre class="mt-2 max-h-48 overflow-auto border-l border-border-subtle pl-3 py-1 text-small leading-6 whitespace-pre-wrap wrap-break-word text-text-muted">{{ memoryContext.queryText || "空查询" }}</pre>
            </section>

            <section class="min-w-0">
              <div class="text-small text-text-subtle">语义召回统计</div>
              <div class="mt-2 grid gap-1.5 md:grid-cols-2">
                <div v-for="[label, value] in memoryRetrievalRows" :key="label" class="flex min-w-0 items-start justify-between gap-3 border-b border-border-subtle py-1.5">
                  <span class="text-small text-text-subtle">{{ label }}</span>
                  <span class="break-all text-right font-mono text-small text-text-secondary">{{ value }}</span>
                </div>
              </div>
            </section>

            <div class="min-w-0">
              <div class="mb-2 text-small text-text-subtle">语义召回记忆</div>
              <WorkbenchEmptyState v-if="memoryContext.retrievedUserContext.length === 0" :centered="false" class="rounded border border-dashed border-border-default px-3 py-3 text-small text-text-subtle" message="无语义召回记忆进入 prompt" />
              <div v-else class="grid min-w-0 gap-3 lg:grid-cols-2">
                <WorkbenchCard v-for="item in memoryContext.retrievedUserContext" :key="item.itemId" class="min-w-0 overflow-hidden" surface="sidebar">
                  <div class="break-all text-small text-text-secondary">{{ item.title || item.itemId }}</div>
                  <div class="mt-1 break-all font-mono text-small text-text-muted">{{ item.itemId }}</div>
                  <div class="mt-1 text-small text-text-subtle">{{ formatMemoryItemMeta(item) }}</div>
                  <div class="mt-2 max-h-40 overflow-auto whitespace-pre-wrap wrap-break-word text-small leading-6 text-text-muted">{{ item.text }}</div>
                </WorkbenchCard>
              </div>
            </div>
          </div>
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
          :expanded="isDisclosureExpanded('content-safety')"
          collapsed-title="内容安全屏蔽记录"
          expanded-title="内容安全屏蔽记录"
          :summary="`${detail?.session.contentSafetyAudits.length ?? 0} 项`"
          @toggle="toggleDisclosure('content-safety')"
        >
          <WorkbenchEmptyState v-if="(detail?.session.contentSafetyAudits.length ?? 0) === 0" :centered="false" class="rounded border border-dashed border-border-default px-3 py-3 text-small text-text-subtle" message="暂无屏蔽记录" />
          <div v-else class="grid min-w-0 gap-3 lg:grid-cols-2">
            <WorkbenchCard v-for="record in detail?.session.contentSafetyAudits ?? []" :key="record.key" class="min-w-0 overflow-hidden" surface="sidebar">
              <div class="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <span class="min-w-0 break-all font-mono text-small text-text-secondary">{{ record.key }}</span>
                <span class="text-small" :class="record.decision === 'block' ? 'text-danger' : record.decision === 'review' ? 'text-warning' : 'text-text-subtle'">{{ record.decision }}</span>
              </div>
              <div class="mt-1 text-small text-text-subtle">{{ formatSafetySubject(record.subjectKind) }} · {{ formatTimestamp(record.checkedAtMs) }}</div>
              <div class="mt-2 whitespace-pre-wrap wrap-break-word text-small text-text-muted">原因：{{ record.reason }}</div>
              <div class="mt-1 break-all text-small text-text-muted">标签：{{ formatSafetyLabels(record.labels) }}</div>
              <div v-if="record.fileId" class="mt-1 break-all font-mono text-small text-text-muted">fileId: {{ record.fileId }}</div>
              <div v-if="record.sourceName" class="mt-1 break-all text-small text-text-muted">文件名：{{ record.sourceName }}</div>
              <div v-if="record.requestId" class="mt-1 break-all font-mono text-small text-text-muted">requestId: {{ record.requestId }}</div>
              <div v-if="record.originalText" class="mt-2">
                <div class="mb-1 text-small text-text-subtle">原文</div>
                <pre class="m-0 max-h-64 overflow-auto rounded border border-border-default bg-surface-sidebar p-2 text-small leading-6 whitespace-pre-wrap wrap-break-word text-text-muted">{{ record.originalText }}</pre>
              </div>
              <div class="mt-2">
                <div class="mb-1 text-small text-text-subtle">投影标记</div>
                <pre class="m-0 max-h-36 overflow-auto rounded border border-border-default bg-surface-sidebar p-2 text-small leading-6 whitespace-pre-wrap wrap-break-word text-text-muted">{{ record.marker }}</pre>
              </div>
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
            <section class="min-w-0">
              <div class="text-small text-text-subtle">调试控制</div>
              <div class="mt-2 grid gap-1.5">
                <div v-for="[label, value] in debugControlRows" :key="label" class="flex items-start justify-between gap-3 border-b border-border-subtle py-1.5">
                  <span class="text-small text-text-subtle">{{ label }}</span>
                  <span class="text-right text-small text-text-secondary">{{ value }}</span>
                </div>
              </div>
            </section>
            <section class="min-w-0">
              <div class="text-small text-text-subtle">最近 LLM 用量</div>
              <WorkbenchEmptyState
                v-if="lastLlmUsageRows.length === 0"
                :centered="false"
                class="mt-2 rounded border border-dashed border-border-default px-3 py-3 text-small text-text-subtle"
                message="暂无 LLM 用量记录"
              />
              <div v-else class="mt-2 grid gap-1.5">
                <div v-for="[label, value] in lastLlmUsageRows" :key="label" class="flex items-start justify-between gap-3 border-b border-border-subtle py-1.5">
                  <span class="text-small text-text-subtle">{{ label }}</span>
                  <span class="break-all text-right font-mono text-small text-text-secondary">{{ value }}</span>
                </div>
              </div>
            </section>
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
                <span class="min-w-0 break-all font-mono text-small text-text-secondary">{{ marker.kind }}</span>
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
                <span class="min-w-0 break-all font-mono text-small text-text-secondary">messageId {{ message.messageId }}</span>
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
