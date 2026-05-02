import type {
  InternalFallbackEventItem,
  InternalSessionTriggerExecution,
  InternalTriggerEventItem,
  InternalTriggerStage
} from "./sessionTypes.ts";
import type {
  TranscriptTitleGenerationItem
} from "./sessionTypes.ts";

export function formatErrorDetails(error: unknown): string {
  if (error instanceof Error) {
    const parts = [
      error.name?.trim() || "",
      error.message?.trim() || ""
    ].filter((part) => part.length > 0);
    const headline = parts.join(": ");
    if (error.stack?.trim()) {
      return headline ? `${headline}\n\n${error.stack.trim()}` : error.stack.trim();
    }
    return headline || String(error);
  }
  return String(error);
}

export function createModelFallbackEvent(input: {
  timestampMs?: number;
  summary: string;
  details: string;
  fromModelRef: string;
  toModelRef: string;
  fromProvider: string;
  toProvider: string;
}): InternalFallbackEventItem {
  return {
    kind: "fallback_event",
    llmVisible: false,
    timestampMs: input.timestampMs ?? Date.now(),
    fallbackType: "model_candidate_switch",
    title: "模型切换 fallback",
    summary: input.summary,
    details: input.details,
    fromModelRef: input.fromModelRef,
    toModelRef: input.toModelRef,
    fromProvider: input.fromProvider,
    toProvider: input.toProvider
  };
}

export function createGenerationFailureFallbackEvent(input: {
  timestampMs?: number;
  details: string;
  failureMessage: string;
}): InternalFallbackEventItem {
  return {
    kind: "fallback_event",
    llmVisible: false,
    timestampMs: input.timestampMs ?? Date.now(),
    fallbackType: "generation_failure_reply",
    title: "生成失败兜底",
    summary: "本轮生成失败，已发送兜底回复",
    details: input.details,
    failureMessage: input.failureMessage
  };
}

export function createSessionTitleGenerationEvent(input: {
  source: "auto" | "regenerate";
  modeId: string;
  title: string;
  summary: string;
  details: string;
  timestampMs?: number;
}): TranscriptTitleGenerationItem {
  const sourceLabel = input.source === "auto" ? "自动生成" : "重新生成";
  return {
    kind: "title_generation_event",
    llmVisible: false,
    timestampMs: input.timestampMs ?? Date.now(),
    source: input.source,
    modeId: input.modeId,
    title: `标题生成 · ${sourceLabel}`,
    summary: input.summary,
    details: input.details
  };
}

export function createInternalTriggerEvent(input: {
  trigger: InternalSessionTriggerExecution;
  stage: InternalTriggerStage;
  timestampMs?: number;
}): InternalTriggerEventItem {
  const { trigger, stage } = input;
  const title = `内部触发器 · ${formatTriggerStage(stage)}`;
  const summary = buildTriggerSummary(trigger, stage);
  const details = buildTriggerDetails(trigger);
  return {
    kind: "internal_trigger_event",
    llmVisible: false,
    timestampMs: input.timestampMs ?? Date.now(),
    triggerKind: trigger.kind,
    stage,
    title,
    summary,
    jobName: trigger.jobName,
    targetType: trigger.targetType,
    ...(trigger.targetUserId ? { targetUserId: trigger.targetUserId } : {}),
    ...(trigger.targetGroupId ? { targetGroupId: trigger.targetGroupId } : {}),
    ...(trigger.kind === "comfy_task_completed" || trigger.kind === "comfy_task_failed"
      ? {
          taskId: trigger.taskId,
          templateId: trigger.templateId,
          comfyPromptId: trigger.comfyPromptId,
          autoIterationIndex: trigger.autoIterationIndex,
          maxAutoIterations: trigger.maxAutoIterations
        }
      : {}),
    ...(trigger.kind === "terminal_session_closed" || trigger.kind === "terminal_input_required"
      ? { resourceId: trigger.resourceId }
      : {}),
    ...(details ? { details } : {})
  };
}

function formatTriggerStage(stage: InternalTriggerStage): string {
  switch (stage) {
    case "received":
      return "已接收";
    case "queued":
      return "已入队";
    case "dequeued":
      return "已出队";
    case "started":
      return "开始执行";
  }
}

function buildTriggerSummary(trigger: InternalSessionTriggerExecution, stage: InternalTriggerStage): string {
  const stageLabel = formatTriggerStage(stage);
  const target = trigger.targetType === "group"
    ? `群 ${trigger.targetGroupId ?? "unknown"}`
    : `私聊 ${trigger.targetUserId ?? "unknown"}`;
  if (trigger.kind === "scheduled_instruction") {
    return `${stageLabel}定时任务「${trigger.jobName}」，目标 ${target}`;
  }
  if (trigger.kind === "comfy_task_completed") {
    return `${stageLabel} Comfy 成功任务「${trigger.jobName}」，模板 ${trigger.templateId}，迭代 ${trigger.autoIterationIndex + 1}/${trigger.maxAutoIterations}`;
  }
  if (trigger.kind === "comfy_task_failed") {
    return `${stageLabel} Comfy 失败任务「${trigger.jobName}」，模板 ${trigger.templateId}，迭代 ${trigger.autoIterationIndex + 1}/${trigger.maxAutoIterations}`;
  }
  if (trigger.kind === "terminal_session_closed") {
    return `${stageLabel}终端完成事件「${trigger.jobName}」，资源 ${trigger.resourceId}`;
  }
  return `${stageLabel}终端输入事件「${trigger.jobName}」，资源 ${trigger.resourceId}`;
}

function buildTriggerDetails(trigger: InternalSessionTriggerExecution): string | null {
  if (trigger.kind === "scheduled_instruction") {
    return trigger.instruction.trim() || null;
  }

  if (trigger.kind === "terminal_session_closed") {
    return [
      `resourceId: ${trigger.resourceId}`,
      `command: ${trigger.command}`,
      `cwd: ${trigger.cwd}`,
      `exitCode: ${trigger.exitCode ?? "(none)"}`,
      `signal: ${trigger.signal ?? "(none)"}`,
      `outputTruncated: ${trigger.outputTruncated ? "true" : "false"}`,
      `instruction: ${trigger.instruction}`
    ].join("\n");
  }

  if (trigger.kind === "terminal_input_required") {
    return [
      `resourceId: ${trigger.resourceId}`,
      `command: ${trigger.command}`,
      `cwd: ${trigger.cwd}`,
      `promptKind: ${trigger.promptKind}`,
      `promptText: ${trigger.promptText}`,
      `instruction: ${trigger.instruction}`
    ].join("\n");
  }

  const lines = [
    `taskId: ${trigger.taskId}`,
    `templateId: ${trigger.templateId}`,
    `comfyPromptId: ${trigger.comfyPromptId}`,
    `aspectRatio: ${trigger.aspectRatio}`,
    `resolvedSize: ${trigger.resolvedWidth}x${trigger.resolvedHeight}`,
    `autoIteration: ${trigger.autoIterationIndex + 1}/${trigger.maxAutoIterations}`,
    `instruction: ${trigger.instruction}`
  ];

  if (trigger.kind === "comfy_task_completed") {
    lines.push(`workspaceFileIds: ${trigger.workspaceFileIds.join(", ") || "(none)"}`);
    lines.push(`chatFilePaths: ${trigger.chatFilePaths.join(", ") || "(none)"}`);
  } else {
    lines.push(`lastError: ${trigger.lastError}`);
  }

  return lines.join("\n");
}
