<script setup lang="ts">
import { computed, inject } from "vue";
import { Bot, GitBranch, Image as ImageIcon, Info, MoreHorizontal, User, Wrench } from "lucide-vue-next";
import type { StoredToolCall, TranscriptItem } from "@/api/types";
import SessionGlyph, { type SessionGlyphModel } from "./SessionGlyph.vue";
import { WorkbenchCard, WorkbenchDisclosure } from "@/components/workbench/primitives";
import TranscriptTextBlock from "./TranscriptTextBlock.vue";
import type { TranscriptExpandState } from "./ChatPanel.vue";

const props = defineProps<{
  item: TranscriptItem;
  index: number;
}>();

const emit = defineEmits<{
  openActions: [];
}>();

const expandStates = inject<Map<string, TranscriptExpandState>>("transcriptExpandStates");
const runtimeExcluded = computed(() => props.item.runtimeExcluded === true);

function getState(): TranscriptExpandState {
  if (!expandStates) {
    return { expanded: false, reasoningExpanded: false, plannerExpanded: false };
  }
  if (!expandStates.has(props.item.id)) {
    expandStates.set(props.item.id, { expanded: false, reasoningExpanded: false, plannerExpanded: false });
  }
  return expandStates.get(props.item.id)!;
}

const expanded = computed(() => getState().expanded);
const reasoningExpanded = computed(() => getState().reasoningExpanded);
const plannerExpanded = computed(() => getState().plannerExpanded);

function toggleExpanded() {
  const s = getState();
  s.expanded = !s.expanded;
}
function toggleReasoningExpanded() {
  const s = getState();
  s.reasoningExpanded = !s.reasoningExpanded;
}
function togglePlannerExpanded() {
  const s = getState();
  s.plannerExpanded = !s.plannerExpanded;
}

const timeStr = computed(() => {
  const d = new Date(props.item.timestampMs);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
});

const toolNames = computed(() => {
  if (props.item.kind !== "assistant_tool_call") {
    return [];
  }
  return props.item.toolCalls
    .map((toolCall) => getDisplayToolName(toolCall))
    .filter((name, index, list) => name.length > 0 && list.indexOf(name) === index);
});

const itemTitle = computed(() => {
  let title;
  switch (props.item.kind) {
    case "user_message":
      title = `用户消息`;
      break;
    case "assistant_message":
      title = `模型回复`;
      break;
    case "session_mode_switch":
      title = "会话模式切换";
      break;
    case "direct_command":
      title = `${props.item.direction === "input" ? "指令输入" : "指令输出"} · ${props.item.commandName}`;
      break;
    case "status_message":
      title = `${props.item.statusType === "command" ? "指令状态" : "系统状态"}`;
      break;
    case "assistant_tool_call":
      title = `工具调用${toolNames.value.length > 0 ? ` · ${toolNames.value.join("、")}` : ""}`;
      break;
    case "tool_result":
      title = `工具结果 · ${props.item.toolName || "未知工具结果"}`;
      break;
    case "outbound_media_message":
      title = `发送图片 · ${props.item.toolName}`;
      break;
    case "gate_decision":
      title = `Turn Planner 判定 · ${formatPlannerAction(props.item.action)}`;
      break;
    case "title_generation_event":
      title = props.item.title;
      break;
    case "system_marker":
      title = `系统标记 · ${props.item.markerType}`;
      break;
    case "fallback_event":
      title = props.item.title;
      break;
    case "internal_trigger_event":
      title = props.item.title;
      break;
  }
  if (!props.item.llmVisible) {
    title += " · 隐藏";
  }
  return title;
});

const itemTone = computed(() => {
  switch (props.item.kind) {
    case "user_message":
      return "user";
    case "assistant_message":
    case "session_mode_switch":
      return "assistant";
    case "direct_command":
      return props.item.direction === "input" ? "command" : "command-output";
    case "status_message":
      return "status";
    case "assistant_tool_call":
      return "tool-call";
    case "tool_result":
      return "tool-result";
    case "outbound_media_message":
      return "outbound-media";
    case "gate_decision":
      return props.item.action === "wait" ? "gate-wait" : props.item.action === "skip" ? "gate-skip" : "gate";
    case "title_generation_event":
      return "status";
    case "system_marker":
      return "marker";
    case "fallback_event":
      return props.item.fallbackType === "generation_failure_reply" ? "gate-skip" : "gate";
    case "internal_trigger_event":
      return "status";
  }
});

const itemGlyph = computed<SessionGlyphModel>(() => {
  switch (props.item.kind) {
    case "user_message":
      return { kind: "icon", component: User, size: 13, strokeWidth: 2.1 };
    case "assistant_message":
    case "session_mode_switch":
      return { kind: "icon", component: Bot, size: 13, strokeWidth: 2 };
    case "direct_command":
      return { kind: "text", value: props.item.direction === "input" ? "." : ">" };
    case "status_message":
      return { kind: "icon", component: Info, size: 13, strokeWidth: 2.1 };
    case "assistant_tool_call":
      return { kind: "icon", component: Wrench, size: 13, strokeWidth: 2 };
    case "tool_result":
      return { kind: "text", value: "R" };
    case "outbound_media_message":
      return { kind: "icon", component: ImageIcon, size: 13, strokeWidth: 2 };
    case "gate_decision":
      return { kind: "icon", component: GitBranch, size: 13, strokeWidth: 2 };
    case "title_generation_event":
      return { kind: "icon", component: Info, size: 13, strokeWidth: 2.1 };
    case "system_marker":
      return { kind: "text", value: "M" };
    case "fallback_event":
      return { kind: "text", value: "F" };
    case "internal_trigger_event":
      return { kind: "text", value: "I" };
  }
});

const toneGlyphClass = computed(() => {
  switch (itemTone.value) {
    case "user":
      return "bg-[color-mix(in_srgb,var(--surface-selected)_70%,transparent)] text-text-accent";
    case "assistant":
      return "bg-[color-mix(in_srgb,var(--surface-success)_72%,transparent)] text-success";
    case "command":
    case "command-output":
      return "bg-[color-mix(in_srgb,var(--surface-warning)_72%,transparent)] text-warning";
    case "status":
    case "marker":
      return "bg-[color-mix(in_srgb,var(--surface-input)_82%,transparent)] text-text-muted";
    case "tool-call":
      return "bg-[color-mix(in_srgb,var(--surface-warning)_74%,transparent)] text-warning";
    case "tool-result":
      return "bg-[color-mix(in_srgb,var(--surface-success)_74%,transparent)] text-success";
    case "outbound-media":
      return "bg-[color-mix(in_srgb,var(--surface-info)_74%,transparent)] text-info";
    case "gate":
    case "gate-wait":
    case "gate-skip":
      return "bg-[color-mix(in_srgb,var(--surface-info)_72%,transparent)] text-info";
  }
});

const metaChips = computed(() => {
  let chips: string[];
  switch (props.item.kind) {
    case "user_message":
      chips = [
        `${props.item.senderName} (${props.item.userId})`,
        ...(props.item.replyMessageId ? ["reply"] : []),
        ...(props.item.mentionedSelf ? ["@self"] : []),
        ...(props.item.mentionedAll ? ["@all"] : []),
        ...(props.item.imageIds.length > 0 ? [`image=${props.item.imageIds.length}`] : []),
        ...(props.item.emojiIds.length > 0 ? [`emoji=${props.item.emojiIds.length}`] : []),
        ...((props.item.specialSegments?.length ?? 0) > 0 ? [`segment=${props.item.specialSegments?.length ?? 0}`] : []),
        ...(props.item.audioCount > 0 ? [`audio=${props.item.audioCount}`] : []),
        ...(props.item.forwardIds.length > 0 ? [`forward=${props.item.forwardIds.length}`] : [])
      ];
      break;
    case "assistant_message":
      chips = props.item.chatType === "group"
        ? [`${props.item.senderName} (${props.item.userId})`]
        : [];
      break;
    case "session_mode_switch":
      chips = [`${props.item.fromModeId} -> ${props.item.toModeId}`];
      break;
    case "direct_command":
      chips = [props.item.direction === "input" ? "用户指令" : "指令返回"];
      break;
    case "status_message":
      chips = [props.item.statusType === "command" ? "命令链路" : "系统链路"];
      break;
    case "assistant_tool_call":
      chips = [
        ...toolNames.value,
        ...(props.item.toolCalls.length > 1 ? [`${props.item.toolCalls.length} 个调用`] : [])
      ];
      break;
    case "tool_result":
      chips = props.item.toolCallId ? [props.item.toolCallId] : [];
      break;
    case "outbound_media_message":
      chips = [
        props.item.fileId,
        props.item.fileRef,
        props.item.sourcePath,
        props.item.messageId != null ? `messageId=${props.item.messageId}` : null
      ].filter(Boolean) as string[];
      break;
    case "gate_decision":
      chips = [
        `action=${props.item.action}`,
        props.item.replyDecision ? `reply=${props.item.replyDecision}` : null,
        props.item.waitPassCount != null ? `wait#${props.item.waitPassCount}` : null,
        props.item.topicDecision ? `topic=${props.item.topicDecision}` : null,
        props.item.toolsetIds && props.item.toolsetIds.length > 0 ? `toolsets=${props.item.toolsetIds.length}` : null
      ].filter(Boolean) as string[];
      break;
    case "title_generation_event":
      chips = [
        props.item.source === "auto" ? "自动生成" : "重新生成",
        props.item.modeId
      ];
      break;
    case "system_marker":
      chips = [props.item.markerType];
      break;
    case "fallback_event":
      chips = [
        props.item.fallbackType === "model_candidate_switch" ? "模型切换" : "兜底回复",
        props.item.fromModelRef && props.item.toModelRef ? `${props.item.fromModelRef} -> ${props.item.toModelRef}` : null,
        props.item.fromProvider && props.item.toProvider ? `${props.item.fromProvider} -> ${props.item.toProvider}` : null,
        props.item.failureMessage ? "已发送兜底回复" : null
      ].filter(Boolean) as string[];
      break;
    case "internal_trigger_event":
      chips = [
        formatTriggerKind(props.item.triggerKind),
        props.item.jobName,
        props.item.targetType === "group"
          ? `group=${props.item.targetGroupId ?? "unknown"}`
          : `user=${props.item.targetUserId ?? "unknown"}`,
        props.item.templateId ? `template=${props.item.templateId}` : null,
        props.item.taskId ? `task=${props.item.taskId}` : null,
        props.item.autoIterationIndex != null && props.item.maxAutoIterations != null
          ? `iter=${props.item.autoIterationIndex + 1}/${props.item.maxAutoIterations}`
          : null
      ].filter(Boolean) as string[];
      break;
  }
  return [...chips, ...formatTokenStatChips(props.item.tokenStats)];
});

const plannerReasonText = computed(() => {
  if (props.item.kind !== "gate_decision") {
    return null;
  }
  return normalizeText(props.item.reason ?? "");
});

const plannerOutputRows = computed(() => {
  if (props.item.kind !== "gate_decision") {
    return [];
  }
  return [
    { key: "action", value: props.item.action },
    { key: "replyDecision", value: props.item.replyDecision ?? null },
    { key: "topicDecision", value: props.item.topicDecision ?? null },
    { key: "waitPassCount", value: props.item.waitPassCount != null ? String(props.item.waitPassCount) : null },
    { key: "toolsetIds", value: props.item.toolsetIds && props.item.toolsetIds.length > 0 ? props.item.toolsetIds.join(", ") : null }
  ];
});

const outboundMediaRows = computed(() => {
  if (props.item.kind !== "outbound_media_message") {
    return [];
  }
  return [
    { label: "发送到", value: props.item.delivery },
    { label: "文件 ID", value: props.item.fileId || "无" },
    { label: "文件引用", value: props.item.fileRef || "无" },
    { label: "原始文件名", value: props.item.sourceName || "未命名图片" },
    { label: "工作区路径", value: props.item.chatFilePath || "无" },
    { label: "发送路径", value: props.item.sourcePath || "无" },
    { label: "消息 ID", value: props.item.messageId != null ? String(props.item.messageId) : "无" }
  ];
});

function normalizeText(value: string): string | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  return normalized;
}

function formatPlannerAction(action: "continue" | "wait" | "skip" | "topic_switch"): string {
  switch (action) {
    case "continue":
      return "继续回复";
    case "wait":
      return "继续等待";
    case "skip":
      return "跳过";
    case "topic_switch":
      return "切题压缩";
  }
}

function getDisplayToolName(toolCall: StoredToolCall): string {
  return String(toolCall.function?.name ?? "").trim();
}

function getToolArguments(toolCall: StoredToolCall): string {
  return String(toolCall.function?.arguments ?? "").trim();
}

function formatMaybeJson(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return value;
  }
}

function formatTriggerKind(kind: "scheduled_instruction" | "comfy_task_completed" | "comfy_task_failed"): string {
  switch (kind) {
    case "scheduled_instruction":
      return "scheduled_instruction";
    case "comfy_task_completed":
      return "comfy_task_completed";
    case "comfy_task_failed":
      return "comfy_task_failed";
  }
}

function formatTokenStatChips(tokenStats: TranscriptItem["tokenStats"] | undefined): string[] {
  if (!tokenStats) {
    return [];
  }
  return [
    tokenStats.input ? `in=${tokenStats.input.tokens}${tokenStats.input.source === "estimated" ? "e" : ""}` : null,
    tokenStats.output ? `out=${tokenStats.output.tokens}${tokenStats.output.source === "estimated" ? "e" : ""}` : null,
    tokenStats.reasoning ? `think=${tokenStats.reasoning.tokens}${tokenStats.reasoning.source === "estimated" ? "e" : ""}` : null
  ].filter(Boolean) as string[];
}

function openActions(): void {
  emit("openActions");
}
</script>

<template>
  <article
    class="grid grid-cols-[56px_minmax(0,1fr)] gap-2.5 border-b border-border-subtle px-3 py-2.5 max-[720px]:grid-cols-[42px_minmax(0,1fr)] max-[720px]:gap-2"
    :class="runtimeExcluded ? 'opacity-45' : ''"
  >
    <div class="flex flex-col items-center gap-1.5 pt-0.5">
      <SessionGlyph :glyph="itemGlyph" :tone-class="toneGlyphClass" />
      <span class="font-mono text-small text-text-subtle">#{{ index }}</span>
    </div>

    <div class="flex min-w-0 flex-col gap-2">
      <header class="flex flex-col gap-1.5">
        <div class="flex items-baseline justify-between gap-3 max-[720px]:flex-col max-[720px]:items-start max-[720px]:gap-1">
          <span class="text-ui font-semibold text-text-secondary">{{ itemTitle }}</span>
          <div class="flex shrink-0 items-center gap-1.5 text-text-subtle max-[720px]:text-[11px]">
            <span class="font-mono text-small">{{ timeStr }}</span>
            <button
              class="inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded border-0 bg-transparent p-0 text-text-subtle transition-colors hover:text-text-primary"
              title="消息操作"
              @click="openActions"
            >
              <MoreHorizontal :size="14" :stroke-width="2" />
            </button>
          </div>
        </div>
        <div v-if="metaChips.length > 0" class="flex flex-wrap gap-1.5">
          <span v-for="chip in metaChips" :key="chip" class="rounded-full border border-border-default bg-surface-input px-2 py-0.5 text-small text-text-muted">{{ chip }}</span>
        </div>
      </header>

      <div v-if="item.kind === 'user_message'" class="flex flex-col gap-2">
        <TranscriptTextBlock v-if="item.text" :text="item.text" />
        <TranscriptTextBlock
          v-if="(item.specialSegments?.length ?? 0) > 0"
          :text="item.specialSegments?.map((segment) => segment.summary).join('\n') ?? ''"
          tone="muted"
        />
      </div>

      <div v-else-if="item.kind === 'assistant_message'" class="flex flex-col gap-2">
        <WorkbenchDisclosure
          v-if="item.reasoningContent"
          :expanded="reasoningExpanded"
          collapsed-title="展开思考过程"
          expanded-title="收起思考过程"
          @toggle="toggleReasoningExpanded"
        >
          <TranscriptTextBlock :text="item.reasoningContent" tone="muted" />
        </WorkbenchDisclosure>
        <TranscriptTextBlock :text="item.text" />
      </div>

      <div v-else-if="item.kind === 'session_mode_switch'" class="flex flex-col gap-2">
        <TranscriptTextBlock :text="item.content" />
      </div>

      <div v-else-if="item.kind === 'direct_command'" class="flex flex-col gap-2">
        <TranscriptTextBlock :text="item.content" />
      </div>

      <div v-else-if="item.kind === 'status_message'" class="flex flex-col gap-2">
        <TranscriptTextBlock :text="item.content" />
      </div>

      <div v-else-if="item.kind === 'assistant_tool_call'" class="flex flex-col gap-2">
        <WorkbenchDisclosure
          v-if="item.reasoningContent"
          :expanded="reasoningExpanded"
          collapsed-title="展开思考过程"
          expanded-title="收起思考过程"
          @toggle="toggleReasoningExpanded"
        >
          <TranscriptTextBlock :text="item.reasoningContent" tone="muted" />
        </WorkbenchDisclosure>
        <WorkbenchDisclosure
          :expanded="expanded"
          collapsed-title="展开参数"
          expanded-title="收起参数"
          :summary="toolNames.length > 0 ? toolNames.join('、') : `${item.toolCalls.length} 个调用`"
          @toggle="toggleExpanded"
        >
          <WorkbenchCard v-for="toolCall in item.toolCalls" :key="toolCall.id" :title="getDisplayToolName(toolCall) || '未知工具'">
            <div class="font-mono text-small text-text-muted">toolCallId: {{ toolCall.id }}</div>
            <TranscriptTextBlock v-if="getToolArguments(toolCall)" class="mt-2" :text="formatMaybeJson(getToolArguments(toolCall))" :wrap="false" />
          </WorkbenchCard>
          <WorkbenchCard v-if="item.content" title="模型工具消息">
            <TranscriptTextBlock :text="item.content" />
          </WorkbenchCard>
        </WorkbenchDisclosure>
      </div>

      <div v-else-if="item.kind === 'tool_result'" class="flex flex-col gap-2">
        <WorkbenchDisclosure
          :expanded="expanded"
          collapsed-title="展开结果"
          expanded-title="收起结果"
          :summary="item.toolName || '未知工具结果'"
          @toggle="toggleExpanded"
        >
          <WorkbenchCard title="工具输出">
            <div v-if="item.toolCallId" class="font-mono text-small text-text-muted">toolCallId: {{ item.toolCallId }}</div>
            <TranscriptTextBlock class="mt-2" :text="formatMaybeJson(item.content)" :wrap="false" />
          </WorkbenchCard>
        </WorkbenchDisclosure>
      </div>

      <div v-else-if="item.kind === 'outbound_media_message'" class="flex flex-col gap-2">
        <WorkbenchCard v-for="row in outboundMediaRows" :key="row.label">
          <div class="flex items-center justify-between gap-3">
            <div class="text-small tracking-[0.05em] text-text-subtle uppercase">{{ row.label }}</div>
            <div class="font-mono text-small text-text-muted">{{ row.value }}</div>
          </div>
        </WorkbenchCard>
      </div>

      <div v-else-if="item.kind === 'gate_decision'" class="flex flex-col gap-2">
        <WorkbenchDisclosure
          v-if="item.reasoningContent"
          :expanded="reasoningExpanded"
          collapsed-title="展开思考过程"
          expanded-title="收起思考过程"
          @toggle="toggleReasoningExpanded"
        >
          <TranscriptTextBlock :text="item.reasoningContent" tone="muted" />
        </WorkbenchDisclosure>
        <WorkbenchDisclosure
          :expanded="plannerExpanded"
          collapsed-title="展开规划输出"
          expanded-title="收起规划输出"
          :summary="item.action"
          @toggle="togglePlannerExpanded"
        >
          <WorkbenchCard title="规划输出">
            <div class="grid gap-1.5">
              <WorkbenchCard v-for="row in plannerOutputRows" :key="row.key" compact>
                <div class="flex items-start justify-between gap-3">
                  <span class="font-mono text-small text-text-subtle">{{ row.key }}</span>
                  <span class="font-mono text-small text-text-muted text-right wrap-break-word">{{ row.value ?? "null" }}</span>
                </div>
              </WorkbenchCard>
              <WorkbenchCard compact>
                <div class="mb-1 font-mono text-small text-text-subtle">reason</div>
                <pre class="m-0 overflow-x-auto font-mono text-mono text-text-muted whitespace-pre-wrap wrap-break-word">{{ plannerReasonText ?? "null" }}</pre>
              </WorkbenchCard>
            </div>
          </WorkbenchCard>
        </WorkbenchDisclosure>
      </div>

      <div v-else-if="item.kind === 'title_generation_event'" class="flex flex-col gap-2">
        <p class="m-0 whitespace-pre-wrap wrap-break-word text-text-muted">{{ item.summary }}</p>
        <WorkbenchDisclosure
          :expanded="expanded"
          collapsed-title="展开详细信息"
          expanded-title="收起详细信息"
          :summary="item.source === 'auto' ? '自动生成' : '重新生成'"
          @toggle="toggleExpanded"
        >
          <WorkbenchCard title="详细信息">
            <div class="grid gap-1.5">
              <WorkbenchCard compact>
                <div class="flex items-start justify-between gap-3">
                  <span class="font-mono text-small text-text-subtle">source</span>
                  <span class="font-mono text-small text-text-muted text-right wrap-break-word">{{ item.source }}</span>
                </div>
              </WorkbenchCard>
              <WorkbenchCard compact>
                <div class="flex items-start justify-between gap-3">
                  <span class="font-mono text-small text-text-subtle">modeId</span>
                  <span class="font-mono text-small text-text-muted text-right wrap-break-word">{{ item.modeId }}</span>
                </div>
              </WorkbenchCard>
              <WorkbenchCard compact>
                <div class="mb-1 font-mono text-small text-text-subtle">details</div>
                <pre class="m-0 overflow-x-auto font-mono text-mono text-text-muted whitespace-pre-wrap wrap-break-word">{{ item.details }}</pre>
              </WorkbenchCard>
            </div>
          </WorkbenchCard>
        </WorkbenchDisclosure>
      </div>

      <div v-else-if="item.kind === 'system_marker'" class="flex flex-col gap-2">
        <TranscriptTextBlock :text="item.content" />
      </div>

      <div v-else-if="item.kind === 'fallback_event'" class="flex flex-col gap-2">
        <p class="m-0 whitespace-pre-wrap wrap-break-word text-text-muted">{{ item.summary }}</p>
        <WorkbenchDisclosure
          :expanded="expanded"
          collapsed-title="展开详细信息"
          expanded-title="收起详细信息"
          :summary="item.fallbackType === 'model_candidate_switch' ? 'fallback' : '兜底回复'"
          @toggle="toggleExpanded"
        >
          <WorkbenchCard title="详细信息">
            <TranscriptTextBlock :text="item.details" />
          </WorkbenchCard>
          <WorkbenchCard v-if="item.failureMessage" title="发送给用户的兜底回复">
            <TranscriptTextBlock :text="item.failureMessage" />
          </WorkbenchCard>
        </WorkbenchDisclosure>
      </div>

      <div v-else-if="item.kind === 'internal_trigger_event'" class="flex flex-col gap-2">
        <p class="m-0 whitespace-pre-wrap wrap-break-word text-text-muted">{{ item.summary }}</p>
        <WorkbenchDisclosure
          v-if="item.details"
          :expanded="expanded"
          collapsed-title="展开详细信息"
          expanded-title="收起详细信息"
          :summary="item.stage"
          @toggle="toggleExpanded"
        >
          <WorkbenchCard title="详细信息">
            <TranscriptTextBlock :text="item.details" />
          </WorkbenchCard>
        </WorkbenchDisclosure>
      </div>
    </div>
  </article>
</template>
