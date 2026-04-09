<script setup lang="ts">
import { computed, ref } from "vue";
import type { StoredToolCall, TranscriptItem } from "@/api/types";

const props = defineProps<{
  item: TranscriptItem;
  index: number;
}>();

const expanded = ref(false);
const reasoningExpanded = ref(false);

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
    case "system_marker":
      return "marker";
    case "fallback_event":
      return props.item.fallbackType === "generation_failure_reply" ? "gate-skip" : "gate";
    case "internal_trigger_event":
      return "status";
  }
});

const itemGlyph = computed(() => {
  switch (props.item.kind) {
    case "user_message":
      return "U";
    case "assistant_message":
      return "A";
    case "direct_command":
      return props.item.direction === "input" ? "." : ">";
    case "status_message":
      return "S";
    case "assistant_tool_call":
      return "T";
    case "tool_result":
      return "R";
    case "outbound_media_message":
      return "I";
    case "gate_decision":
      return "G";
    case "system_marker":
      return "M";
    case "fallback_event":
      return "F";
    case "internal_trigger_event":
      return "I";
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
  switch (props.item.kind) {
    case "user_message":
      return [
        `${props.item.senderName} (${props.item.userId})`,
        ...(props.item.replyMessageId ? ["reply"] : []),
        ...(props.item.mentionedSelf ? ["@self"] : []),
        ...(props.item.mentionedAll ? ["@all"] : []),
        ...(props.item.imageIds.length > 0 ? [`image=${props.item.imageIds.length}`] : []),
        ...(props.item.emojiIds.length > 0 ? [`emoji=${props.item.emojiIds.length}`] : []),
        ...(props.item.audioCount > 0 ? [`audio=${props.item.audioCount}`] : []),
        ...(props.item.forwardIds.length > 0 ? [`forward=${props.item.forwardIds.length}`] : [])
      ];
    case "assistant_message":
      return props.item.chatType === "group"
        ? [`${props.item.senderName} (${props.item.userId})`]
        : [];
    case "direct_command":
      return [props.item.direction === "input" ? "用户指令" : "指令返回"];
    case "status_message":
      return [props.item.statusType === "command" ? "命令链路" : "系统链路"];
    case "assistant_tool_call":
      return [
        ...toolNames.value,
        ...(props.item.toolCalls.length > 1 ? [`${props.item.toolCalls.length} 个调用`] : [])
      ];
    case "tool_result":
      return props.item.toolCallId ? [props.item.toolCallId] : [];
    case "outbound_media_message":
      return [
        props.item.fileId,
        props.item.fileRef,
        props.item.messageId != null ? `messageId=${props.item.messageId}` : null
      ].filter(Boolean) as string[];
    case "gate_decision":
      return [
        `action=${props.item.action}`,
        props.item.replyDecision ? `reply=${props.item.replyDecision}` : null,
        props.item.waitPassCount != null ? `wait#${props.item.waitPassCount}` : null,
        props.item.topicDecision ? `topic=${props.item.topicDecision}` : null,
        props.item.toolsetIds && props.item.toolsetIds.length > 0 ? `toolsets=${props.item.toolsetIds.length}` : null
      ].filter(Boolean) as string[];
    case "system_marker":
      return [props.item.markerType];
    case "fallback_event":
      return [
        props.item.fallbackType === "model_candidate_switch" ? "模型切换" : "兜底回复",
        props.item.fromModelRef && props.item.toModelRef ? `${props.item.fromModelRef} -> ${props.item.toModelRef}` : null,
        props.item.fromProvider && props.item.toProvider ? `${props.item.fromProvider} -> ${props.item.toProvider}` : null,
        props.item.failureMessage ? "已发送兜底回复" : null
      ].filter(Boolean) as string[];
    case "internal_trigger_event":
      return [
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
  }
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
  return String(toolCall.name ?? toolCall.function?.name ?? "").trim();
}

function getToolArguments(toolCall: StoredToolCall): string {
  return String(toolCall.arguments ?? toolCall.function?.arguments ?? "").trim();
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
</script>

<template>
  <article class="grid grid-cols-[56px_minmax(0,1fr)] gap-2.5 border-b border-border-subtle px-3 py-2.5 max-[720px]:grid-cols-[42px_minmax(0,1fr)] max-[720px]:gap-2">
    <div class="flex flex-col items-center gap-1.5 pt-0.5">
      <span class="flex h-6 w-6 items-center justify-center rounded-full border border-current text-[11px] font-bold" :class="toneGlyphClass">{{ itemGlyph }}</span>
      <span class="font-mono text-small text-text-subtle">#{{ index }}</span>
    </div>

    <div class="flex min-w-0 flex-col gap-2">
      <header class="flex flex-col gap-1.5">
        <div class="flex items-baseline justify-between gap-3 max-[720px]:flex-col max-[720px]:items-start max-[720px]:gap-1">
          <span class="text-ui font-semibold text-text-secondary">{{ itemTitle }}</span>
          <span class="shrink-0 font-mono text-small text-text-subtle max-[720px]:text-[11px]">{{ timeStr }}</span>
        </div>
        <div v-if="metaChips.length > 0" class="flex flex-wrap gap-1.5">
          <span v-for="chip in metaChips" :key="chip" class="rounded-full border border-border-default bg-surface-input px-2 py-0.5 text-small text-text-muted">{{ chip }}</span>
        </div>
      </header>

      <div v-if="item.kind === 'user_message'" class="flex flex-col gap-2">
        <pre class="m-0 overflow-x-auto rounded-lg border border-border-default bg-surface-input p-2.5 font-mono text-mono text-text-primary whitespace-pre-wrap wrap-break-word">{{ item.text }}</pre>
      </div>

      <div v-else-if="item.kind === 'assistant_message'" class="flex flex-col gap-2">
        <template v-if="item.reasoningContent">
          <button class="flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg border border-border-default bg-surface-input px-2.5 py-1.75 text-small text-text-muted hover:text-text-primary" @click="reasoningExpanded = !reasoningExpanded">
            <span>{{ reasoningExpanded ? "收起思考过程" : "展开思考过程" }}</span>
          </button>
          <div v-if="reasoningExpanded" class="flex flex-col gap-2">
            <pre class="m-0 overflow-x-auto rounded-lg border border-border-default bg-surface-input p-2.5 font-mono text-mono text-text-muted whitespace-pre-wrap wrap-break-word">{{ item.reasoningContent }}</pre>
          </div>
        </template>
        <pre class="m-0 overflow-x-auto rounded-lg border border-border-default bg-surface-input p-2.5 font-mono text-mono text-text-primary whitespace-pre-wrap wrap-break-word">{{ item.text }}</pre>
      </div>

      <div v-else-if="item.kind === 'direct_command'" class="flex flex-col gap-2">
        <pre class="m-0 overflow-x-auto rounded-lg border border-border-default bg-surface-input p-2.5 font-mono text-mono text-text-primary whitespace-pre-wrap wrap-break-word">{{ item.content }}</pre>
      </div>

      <div v-else-if="item.kind === 'status_message'" class="flex flex-col gap-2">
        <pre class="m-0 overflow-x-auto rounded-lg border border-border-default bg-surface-input p-2.5 font-mono text-mono text-text-primary whitespace-pre-wrap wrap-break-word">{{ item.content }}</pre>
      </div>

      <div v-else-if="item.kind === 'assistant_tool_call'" class="flex flex-col gap-2">
        <template v-if="item.reasoningContent">
          <button class="flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg border border-border-default bg-surface-input px-2.5 py-1.75 text-small text-text-muted hover:text-text-primary" @click="reasoningExpanded = !reasoningExpanded">
            <span>{{ reasoningExpanded ? "收起思考过程" : "展开思考过程" }}</span>
          </button>
          <div v-if="reasoningExpanded" class="flex flex-col gap-2">
            <pre class="m-0 overflow-x-auto rounded-lg border border-border-default bg-surface-input p-2.5 font-mono text-mono text-text-muted whitespace-pre-wrap wrap-break-word">{{ item.reasoningContent }}</pre>
          </div>
        </template>
        <button class="flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg border border-border-default bg-surface-input px-2.5 py-1.75 text-small text-text-muted hover:text-text-primary" @click="expanded = !expanded">
          <span>{{ expanded ? "收起参数" : "展开参数" }}</span>
          <span>{{ toolNames.length > 0 ? toolNames.join("、") : `${item.toolCalls.length} 个调用` }}</span>
        </button>
        <div v-if="expanded" class="flex flex-col gap-2">
          <section v-for="toolCall in item.toolCalls" :key="toolCall.id" class="rounded-lg border border-border-default bg-[color-mix(in_srgb,var(--surface-input)_78%,transparent)] p-2.5">
            <div class="mb-1 text-small tracking-[0.05em] text-text-subtle uppercase">{{ getDisplayToolName(toolCall) || "未知工具" }}</div>
            <div class="font-mono text-small text-text-muted">toolCallId: {{ toolCall.id }}</div>
            <pre v-if="getToolArguments(toolCall)" class="mt-2 m-0 overflow-x-auto rounded-lg border border-border-default bg-surface-input p-2.5 font-mono text-mono text-text-primary whitespace-pre">{{ formatMaybeJson(getToolArguments(toolCall)) }}</pre>
          </section>
          <section v-if="item.content" class="rounded-lg border border-border-default bg-[color-mix(in_srgb,var(--surface-input)_78%,transparent)] p-2.5">
            <div class="mb-1 text-small tracking-[0.05em] text-text-subtle uppercase">模型工具消息</div>
            <pre class="m-0 overflow-x-auto rounded-lg border border-border-default bg-surface-input p-2.5 font-mono text-mono text-text-primary whitespace-pre-wrap wrap-break-word">{{ item.content }}</pre>
          </section>
        </div>
      </div>

      <div v-else-if="item.kind === 'tool_result'" class="flex flex-col gap-2">
        <button class="flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg border border-border-default bg-surface-input px-2.5 py-1.75 text-small text-text-muted hover:text-text-primary" @click="expanded = !expanded">
          <span>{{ expanded ? "收起结果" : "展开结果" }}</span>
          <span>{{ item.toolName || "未知工具结果" }}</span>
        </button>
        <div v-if="expanded" class="flex flex-col gap-2">
          <section class="rounded-lg border border-border-default bg-[color-mix(in_srgb,var(--surface-input)_78%,transparent)] p-2.5">
            <div class="mb-1 text-small tracking-[0.05em] text-text-subtle uppercase">工具输出</div>
            <div v-if="item.toolCallId" class="font-mono text-small text-text-muted">toolCallId: {{ item.toolCallId }}</div>
            <pre class="mt-2 m-0 overflow-x-auto rounded-lg border border-border-default bg-surface-input p-2.5 font-mono text-mono text-text-primary whitespace-pre">{{ formatMaybeJson(item.content) }}</pre>
          </section>
        </div>
      </div>

      <div v-else-if="item.kind === 'outbound_media_message'" class="flex flex-col gap-2">
        <section class="flex items-center justify-between gap-3 rounded-lg border border-border-default bg-[color-mix(in_srgb,var(--surface-input)_78%,transparent)] p-2.5">
          <div class="text-small tracking-[0.05em] text-text-subtle uppercase">发送到</div>
          <div class="font-mono text-small text-text-muted">{{ item.delivery }}</div>
        </section>
        <section class="flex items-center justify-between gap-3 rounded-lg border border-border-default bg-[color-mix(in_srgb,var(--surface-input)_78%,transparent)] p-2.5">
          <div class="text-small tracking-[0.05em] text-text-subtle uppercase">文件 ID</div>
          <div class="font-mono text-small text-text-muted">{{ item.fileId }}</div>
        </section>
        <section class="flex items-center justify-between gap-3 rounded-lg border border-border-default bg-[color-mix(in_srgb,var(--surface-input)_78%,transparent)] p-2.5">
          <div class="text-small tracking-[0.05em] text-text-subtle uppercase">文件引用</div>
          <div class="font-mono text-small text-text-muted">{{ item.fileRef || "无" }}</div>
        </section>
        <section class="flex items-center justify-between gap-3 rounded-lg border border-border-default bg-[color-mix(in_srgb,var(--surface-input)_78%,transparent)] p-2.5">
          <div class="text-small tracking-[0.05em] text-text-subtle uppercase">原始文件名</div>
          <div class="font-mono text-small text-text-muted">{{ item.sourceName || "未命名图片" }}</div>
        </section>
        <section class="flex items-center justify-between gap-3 rounded-lg border border-border-default bg-[color-mix(in_srgb,var(--surface-input)_78%,transparent)] p-2.5">
          <div class="text-small tracking-[0.05em] text-text-subtle uppercase">工作区路径</div>
          <div class="font-mono text-small text-text-muted">{{ item.workspacePath || "无" }}</div>
        </section>
        <section class="flex items-center justify-between gap-3 rounded-lg border border-border-default bg-[color-mix(in_srgb,var(--surface-input)_78%,transparent)] p-2.5">
          <div class="text-small tracking-[0.05em] text-text-subtle uppercase">消息 ID</div>
          <div class="font-mono text-small text-text-muted">{{ item.messageId }}</div>
        </section>
      </div>

      <div v-else-if="item.kind === 'gate_decision'" class="flex flex-col gap-2">
        <template v-if="item.reasoningContent">
          <button class="flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg border border-border-default bg-surface-input px-2.5 py-1.75 text-small text-text-muted hover:text-text-primary" @click="reasoningExpanded = !reasoningExpanded">
            <span>{{ reasoningExpanded ? "收起思考过程" : "展开思考过程" }}</span>
          </button>
          <div v-if="reasoningExpanded" class="flex flex-col gap-2">
            <pre class="m-0 overflow-x-auto rounded-lg border border-border-default bg-surface-input p-2.5 font-mono text-mono text-text-muted whitespace-pre-wrap wrap-break-word">{{ item.reasoningContent }}</pre>
          </div>
        </template>
        <section class="rounded-lg border border-border-default bg-[color-mix(in_srgb,var(--surface-input)_78%,transparent)] p-2.5">
          <div class="mb-1 text-small tracking-[0.05em] text-text-subtle uppercase">规划输出</div>
          <div class="grid gap-1.5">
            <div v-for="row in plannerOutputRows" :key="row.key" class="flex items-start justify-between gap-3 rounded-md border border-border-subtle bg-surface-input px-2 py-1.5">
              <span class="font-mono text-small text-text-subtle">{{ row.key }}</span>
              <span class="font-mono text-small text-text-muted text-right wrap-break-word">{{ row.value ?? "null" }}</span>
            </div>
          </div>
        </section>
        <section class="rounded-lg border border-border-default bg-[color-mix(in_srgb,var(--surface-input)_78%,transparent)] p-2.5">
          <div class="mb-1 text-small tracking-[0.05em] text-text-subtle uppercase">reason</div>
          <pre class="m-0 overflow-x-auto rounded-lg border border-border-default bg-surface-input p-2.5 font-mono text-mono text-text-primary whitespace-pre-wrap wrap-break-word">{{ plannerReasonText ?? "null" }}</pre>
        </section>
      </div>

      <div v-else-if="item.kind === 'system_marker'" class="flex flex-col gap-2">
        <pre class="m-0 overflow-x-auto rounded-lg border border-border-default bg-surface-input p-2.5 font-mono text-mono text-text-primary whitespace-pre-wrap wrap-break-word">{{ item.content }}</pre>
      </div>

      <div v-else-if="item.kind === 'fallback_event'" class="flex flex-col gap-2">
        <p class="m-0 whitespace-pre-wrap wrap-break-word text-text-muted">{{ item.summary }}</p>
        <button class="flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg border border-border-default bg-surface-input px-2.5 py-1.75 text-small text-text-muted hover:text-text-primary" @click="expanded = !expanded">
          <span>{{ expanded ? "收起详细信息" : "展开详细信息" }}</span>
          <span>{{ item.fallbackType === "model_candidate_switch" ? "fallback" : "兜底回复" }}</span>
        </button>
        <div v-if="expanded" class="flex flex-col gap-2">
          <section class="rounded-lg border border-border-default bg-[color-mix(in_srgb,var(--surface-input)_78%,transparent)] p-2.5">
            <div class="mb-1 text-small tracking-[0.05em] text-text-subtle uppercase">详细信息</div>
            <pre class="m-0 overflow-x-auto rounded-lg border border-border-default bg-surface-input p-2.5 font-mono text-mono text-text-primary whitespace-pre-wrap wrap-break-word">{{ item.details }}</pre>
          </section>
          <section v-if="item.failureMessage" class="rounded-lg border border-border-default bg-[color-mix(in_srgb,var(--surface-input)_78%,transparent)] p-2.5">
            <div class="mb-1 text-small tracking-[0.05em] text-text-subtle uppercase">发送给用户的兜底回复</div>
            <pre class="m-0 overflow-x-auto rounded-lg border border-border-default bg-surface-input p-2.5 font-mono text-mono text-text-primary whitespace-pre-wrap wrap-break-word">{{ item.failureMessage }}</pre>
          </section>
        </div>
      </div>

      <div v-else-if="item.kind === 'internal_trigger_event'" class="flex flex-col gap-2">
        <p class="m-0 whitespace-pre-wrap wrap-break-word text-text-muted">{{ item.summary }}</p>
        <button v-if="item.details" class="flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg border border-border-default bg-surface-input px-2.5 py-1.75 text-small text-text-muted hover:text-text-primary" @click="expanded = !expanded">
          <span>{{ expanded ? "收起详细信息" : "展开详细信息" }}</span>
          <span>{{ item.stage }}</span>
        </button>
        <section v-if="item.details && expanded" class="rounded-lg border border-border-default bg-[color-mix(in_srgb,var(--surface-input)_78%,transparent)] p-2.5">
          <div class="mb-1 text-small tracking-[0.05em] text-text-subtle uppercase">详细信息</div>
          <pre class="m-0 overflow-x-auto rounded-lg border border-border-default bg-surface-input p-2.5 font-mono text-mono text-text-primary whitespace-pre-wrap wrap-break-word">{{ item.details }}</pre>
        </section>
      </div>
    </div>
  </article>
</template>
