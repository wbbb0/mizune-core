import { buildOpenTag, buildCloseTag, parseProtocolLine } from "#utils/structuredEnvelope.ts";
import type { LlmMessage } from "../llmClient.ts";
import {
  buildUserBatchContent,
  buildProfileDraftBatchContent,
} from "../prompts/trigger-batch.prompt.ts";
import {
  buildBaseSystemLines,
  buildScheduledTaskSystemLines,
  buildSetupSystemLines
} from "../prompts/chat-system.prompt.ts";
import {
  formatConversationHistoryPromptMessage,
  formatScheduledHistoryPromptMessage
} from "../prompts/history-message.prompt.ts";
import { getSessionChatType } from "#conversation/session/sessionIdentity.ts";
import type { PromptInput, ScheduledTaskPromptInput, SetupPromptInput } from "./promptTypes.ts";
import type { AssetHandle } from "#llm/tools/core/fileHandle.ts";
import type { InlineSessionTriggerExecution } from "#conversation/session/sessionTypes.ts";
import { renderPromptSectionRaw } from "../prompts/prompt-section.ts";

export type {
  PromptBatchMessage,
  PromptImageCaption,
  PromptImageVisual,
  PromptEmojiVisual,
  PromptHistoryMessage,
  PromptInput,
  PromptNpcProfile,
  PromptParticipantProfile,
  PromptUserProfile,
  ScheduledTaskPromptInput,
  SetupPromptInput
} from "./promptTypes.ts";

const STABLE_SYSTEM_SECTIONS = new Set([
  "global_persona",
  "global_persona_base",
  "persona_snapshot",
  "rp_profile",
  "rp_profile_snapshot",
  "scenario_profile",
  "scenario_profile_snapshot"
]);

const DEFERRED_TOOL_SECTIONS = new Set([
  "tool_hints",
  "toolset_guidance"
]);

export function buildPrompt(input: PromptInput): LlmMessage[] {
  const lastBatchMessage = input.batchMessages[input.batchMessages.length - 1];
  const batchRenderContext = {
    sessionId: input.sessionId,
    ...(input.modeId ? { modeId: input.modeId } : {}),
    ...(input.userProfile.userId ?? lastBatchMessage?.userId
      ? { currentTriggerUserId: input.userProfile.userId ?? lastBatchMessage?.userId ?? "" }
      : {}),
    ...(input.userProfile.senderName ?? lastBatchMessage?.senderName
      ? { currentTriggerSenderName: input.userProfile.senderName ?? lastBatchMessage?.senderName ?? "" }
      : {})
  };
  const baseSystemLines = buildBaseSystemLines({
    sessionMode: getSessionChatType(input.sessionId),
    ...(input.modeId ? { modeId: input.modeId } : {}),
    ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
    ...(input.visibleToolNames ? { visibleToolNames: input.visibleToolNames } : {}),
    ...(input.activeToolsets ? { activeToolsets: input.activeToolsets } : {}),
    persona: input.persona,
    npcProfiles: input.npcProfiles,
    participantProfiles: input.participantProfiles,
    userProfile: input.userProfile,
    ...(input.currentSessionContext ? { currentSessionContext: input.currentSessionContext } : {}),
    ...(input.currentUserMemories ? { currentUserMemories: input.currentUserMemories } : {}),
    ...(input.retrievedUserContext ? { retrievedUserContext: input.retrievedUserContext } : {}),
    ...(input.globalRules ? { globalRules: input.globalRules } : {}),
    historySummary: input.historySummary,
    ...(input.taskTracker ? { taskTracker: input.taskTracker } : {}),
    liveResources: input.liveResources,
    ...(input.toolsetRules ? { toolsetRules: input.toolsetRules } : {}),
    ...(input.scenarioStateLines ? { scenarioStateLines: input.scenarioStateLines } : {}),
    ...(input.modeProfile ? { modeProfile: input.modeProfile } : {}),
    ...(input.draftMode ? { draftMode: input.draftMode } : {}),
    ...(input.isInSetup ? { isInSetup: input.isInSetup } : {})
  });
  const systemMessages = buildSystemMessages(baseSystemLines);

  const historyMessages: LlmMessage[] = input.recentMessages.map((message) => ({
    role: message.role,
    content: formatConversationHistoryPromptMessage(
      message,
      input.modeId ? { modeId: input.modeId } : undefined
    )
  }));

  const batchContentBuilder = input.draftMode || input.isInSetup
    ? buildProfileDraftBatchContent
    : buildUserBatchContent;

  return [
    ...systemMessages,
    ...(input.lateSystemMessages ?? []).map((content) => ({ role: "system" as const, content })),
    ...((input.replayMessages ?? []) as LlmMessage[]),
    ...historyMessages,
    ...(input.batchMessages.length > 0
      ? [{
          role: "user" as const,
          content: batchContentBuilder(input.batchMessages, batchRenderContext, input.includeBatchMediaCaptions)
        }]
      : []),
    ...(input.tailSystemMessages ?? []).map((content) => ({ role: "system" as const, content }))
  ];
}

export function buildScheduledTaskPrompt(
  input: ScheduledTaskPromptInput & { inlineBatchMessage?: string | undefined }
): LlmMessage[] {
  const taskTracker = shouldIncludeTaskTrackerForScheduledTrigger(input.trigger)
    ? input.taskTracker
    : undefined;
  const baseSystemLines = buildBaseSystemLines({
    sessionMode: input.targetContext.chatType,
    ...(input.modeId ? { modeId: input.modeId } : {}),
    ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
    ...(input.visibleToolNames ? { visibleToolNames: input.visibleToolNames } : {}),
    ...(input.activeToolsets ? { activeToolsets: input.activeToolsets } : {}),
    persona: input.persona,
    npcProfiles: input.npcProfiles,
    participantProfiles: input.participantProfiles,
    userProfile: input.userProfile,
    ...(input.currentSessionContext ? { currentSessionContext: input.currentSessionContext } : {}),
    ...(input.currentUserMemories ? { currentUserMemories: input.currentUserMemories } : {}),
    ...(input.retrievedUserContext ? { retrievedUserContext: input.retrievedUserContext } : {}),
    ...(input.globalRules ? { globalRules: input.globalRules } : {}),
    historySummary: input.historySummary,
    ...(taskTracker ? { taskTracker } : {}),
    liveResources: input.liveResources,
    ...(input.toolsetRules ? { toolsetRules: input.toolsetRules } : {}),
    ...(input.scenarioStateLines ? { scenarioStateLines: input.scenarioStateLines } : {}),
    ...(input.modeProfile ? { modeProfile: input.modeProfile } : {})
  });
  const scheduledSystemLines = buildScheduledTaskSystemLines({
    trigger: input.trigger,
    targetContext: input.targetContext
  });
  const systemMessages = buildSystemMessages(baseSystemLines, scheduledSystemLines);

  const historyMessages: LlmMessage[] = input.recentMessages.map((message) => ({
    role: message.role,
    content: formatScheduledHistoryPromptMessage(
      message,
      input.modeId ? { modeId: input.modeId } : undefined
    )
  }));

  const triggerMessage = input.inlineBatchMessage ?? buildTriggerMessage(input);

  return [
    ...systemMessages,
    ...(input.lateSystemMessages ?? []).map((content) => ({ role: "system" as const, content })),
    ...((input.replayMessages ?? []) as LlmMessage[]),
    ...historyMessages,
    { role: "user", content: triggerMessage },
    ...(input.tailSystemMessages ?? []).map((content) => ({ role: "system" as const, content }))
  ];
}

function buildSystemMessages(
  baseLines: string[],
  extraDynamicLines: string[] = []
): LlmMessage[] {
  const stableLines: string[] = [];
  const dynamicLines: string[] = [];
  const deferredToolLines: string[] = [];

  for (const line of baseLines) {
    const sectionName = getPromptSectionName(line);
    if (sectionName && DEFERRED_TOOL_SECTIONS.has(sectionName)) {
      deferredToolLines.push(line);
      continue;
    }
    if (sectionName && STABLE_SYSTEM_SECTIONS.has(sectionName)) {
      stableLines.push(line);
      continue;
    }
    dynamicLines.push(line);
  }

  dynamicLines.push(...extraDynamicLines, ...deferredToolLines);

  const messages: LlmMessage[] = [];
  if (stableLines.length > 0) {
    messages.push({ role: "system", content: stableLines.join("\n") });
  }
  if (dynamicLines.length > 0) {
    messages.push({ role: "system", content: dynamicLines.join("\n") });
  }
  return messages;
}

function getPromptSectionName(section: string): string | null {
  const firstLine = section.split("\n", 1)[0] ?? "";
  const parsed = parseProtocolLine(firstLine);
  return parsed && !parsed.closing && parsed.tag === "section"
    ? parsed.attrs.name ?? null
    : null;
}

function shouldIncludeTaskTrackerForScheduledTrigger(trigger: ScheduledTaskPromptInput["trigger"]): boolean {
  return trigger.kind !== "scheduled_instruction";
}

function buildTriggerMessage(input: ScheduledTaskPromptInput): string {
  const trigger = input.trigger;

  if (trigger.kind === "scheduled_instruction") {
    return input.targetContext.chatType === "private"
      ? [
          `目标用户：${input.targetContext.senderName} (${input.targetContext.userId})`,
          `任务名称：${trigger.jobName}`,
          `任务指令：${trigger.taskInstruction}`
        ].join("\n")
      : [
          `目标群聊：${input.targetContext.groupId}`,
          `任务名称：${trigger.jobName}`,
          `任务指令：${trigger.taskInstruction}`
        ].join("\n");
  }

  // Map prompt-type trigger fields to the shared runtime-type renderer.
  // prompt types use `taskInstruction`; runtime types use `instruction`.
  const asRuntime = { ...trigger, instruction: trigger.taskInstruction } as unknown as InlineSessionTriggerExecution;
  const body = renderTriggerEventBody(asRuntime);

  if (trigger.kind === "comfy_task_completed") {
    const assetHandleLines = formatAssetHandlesForPrompt(trigger.resultAssetHandles);
    const extra = [
      assetHandleLines ? `结果文件 asset_handle：\n${assetHandleLines}` : null
    ].filter(Boolean);
    return extra.length > 0 ? `${body}\n${extra.join("\n")}` : body;
  }

  if (trigger.kind === "download_completed") {
    const assetHandleLine = formatAssetHandlesForPrompt(trigger.resultAssetHandle ? [trigger.resultAssetHandle] : undefined);
    const extra = [
      assetHandleLine ? `结果文件 asset_handle：\n${assetHandleLine}` : null
    ].filter(Boolean);
    return extra.length > 0 ? `${body}\n${extra.join("\n")}` : body;
  }

  return body;
}

function formatAssetHandlesForPrompt(handles: AssetHandle[] | undefined): string {
  if (!handles || handles.length === 0) {
    return "";
  }
  return handles.map((handle) => {
    const selector = handle.asset_ref || handle.asset_id;
    const availableTools = handle.capabilities
      .filter((item) => item.available)
      .map((item) => `${item.capability}:${item.tool} args=${JSON.stringify(item.args)}`)
      .join("；") || "无";
    const nextActions = handle.next_actions?.length
      ? ` next_actions=${JSON.stringify(handle.next_actions)}`
      : "";
    return `- asset_ref=${selector} asset_id=${handle.asset_id} kind=${handle.kind} source_name=${handle.source_name ?? "unknown"} 可用：${availableTools}${nextActions}`;
  }).join("\n");
}

export function buildSetupPrompt(input: SetupPromptInput): LlmMessage[] {
  const lastBatchMessage = input.batchMessages[input.batchMessages.length - 1];
  const batchRenderContext = {
    sessionId: input.sessionId,
    ...(lastBatchMessage?.userId ? { currentTriggerUserId: lastBatchMessage.userId } : {}),
    ...(lastBatchMessage?.senderName ? { currentTriggerSenderName: lastBatchMessage.senderName } : {})
  };
  const setupSystemLines = buildSetupSystemLines({
    sessionId: input.sessionId,
    ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
    persona: input.persona,
    phase: input.phase,
    missingFields: input.missingFields
  });
  const systemMessages = buildSystemMessages(setupSystemLines);

  const historyMessages: LlmMessage[] = input.recentMessages.map((message) => ({
    role: message.role,
    content: formatConversationHistoryPromptMessage(message)
  }));

  return [
    ...systemMessages,
    ...(input.lateSystemMessages ?? []).map((content) => ({ role: "system" as const, content })),
    ...((input.replayMessages ?? []) as LlmMessage[]),
    ...historyMessages,
    ...(input.batchMessages.length > 0
      ? [{
          role: "user" as const,
          content: buildProfileDraftBatchContent(input.batchMessages, batchRenderContext, input.includeBatchMediaCaptions)
        }]
      : []),
    ...(input.tailSystemMessages ?? []).map((content) => ({ role: "system" as const, content }))
  ];
}

// Renders the body lines for a single background-event trigger.
// This is the shared rendering used by both inline injection and
// the classic prompt build path.
export function renderTriggerEventBody(trigger: InlineSessionTriggerExecution): string {
  if (trigger.kind === "comfy_task_completed") {
    return [
      `任务名称：${trigger.jobName}`,
      `任务说明：${trigger.instruction}`,
      `模板：${trigger.templateId}`,
      `prompt：${trigger.positivePrompt}`,
      `比例：${trigger.aspectRatio} -> ${trigger.resolvedWidth}x${trigger.resolvedHeight}`,
      `Comfy prompt_id：${trigger.comfyPromptId}`,
      `asset_id：${trigger.workspaceFileIds.join("、") || "无"}`,
      `asset_path：${trigger.chatFilePaths.join("、") || "无"}`,
      `自动迭代进度：${trigger.autoIterationIndex}/${trigger.maxAutoIterations}`
    ].join("\n");
  }

  if (trigger.kind === "comfy_task_failed") {
    return [
      `任务名称：${trigger.jobName}`,
      `任务说明：${trigger.instruction}`,
      `模板：${trigger.templateId}`,
      `prompt：${trigger.positivePrompt}`,
      `比例：${trigger.aspectRatio} -> ${trigger.resolvedWidth}x${trigger.resolvedHeight}`,
      `Comfy prompt_id：${trigger.comfyPromptId}`,
      `失败原因：${trigger.lastError}`,
      `自动迭代进度：${trigger.autoIterationIndex}/${trigger.maxAutoIterations}`
    ].join("\n");
  }

  if (trigger.kind === "terminal_session_closed") {
    return [
      `任务名称：${trigger.jobName}`,
      `任务说明：${trigger.instruction}`,
      `resource_id：${trigger.resourceId}`,
      `命令：${trigger.command}`,
      `cwd：${trigger.cwd}`,
      `退出码：${trigger.exitCode ?? "无"}`,
      `信号：${trigger.signal ?? "无"}`,
      `输出是否截断：${trigger.outputTruncated ? "是" : "否"}`,
      `输出：\n${trigger.output || "(无输出)"}`
    ].join("\n");
  }

  if (trigger.kind === "terminal_input_required") {
    return [
      `任务名称：${trigger.jobName}`,
      `任务说明：${trigger.instruction}`,
      `resource_id：${trigger.resourceId}`,
      `命令：${trigger.command}`,
      `cwd：${trigger.cwd}`,
      `输入类型：${trigger.promptKind}`,
      `提示文本：${trigger.promptText}`,
      `最近输出：\n${trigger.outputTail || "(无输出)"}`
    ].join("\n");
  }

  if (trigger.kind === "download_completed") {
    return [
      `任务名称：${trigger.jobName}`,
      `任务说明：${trigger.instruction}`,
      `resource_id：${trigger.resourceId}`,
      `来源 URL：${trigger.sourceUrl}`,
      `asset_id：${trigger.fileId}`,
      `asset_ref：${trigger.fileRef}`,
      `asset_path：${trigger.chatFilePath}`,
      `文件名：${trigger.sourceName}`,
      `MIME：${trigger.mimeType}`,
      `大小：${trigger.sizeBytes}`,
      `类型：${trigger.fileKind}`
    ].join("\n");
  }

  // download_failed
  return [
    `任务名称：${trigger.jobName}`,
    `任务说明：${trigger.instruction}`,
    `resource_id：${trigger.resourceId}`,
    `来源 URL：${trigger.sourceUrl}`,
    `失败原因：${trigger.error}`
  ].join("\n");
}

// Renders a batch of background-event triggers as a single user message
// wrapped in the project's structured section markers.
export function renderInlineTriggerBatchMessage(triggers: InlineSessionTriggerExecution[]): string {
  const eventLines: string[] = [];
  for (const trigger of triggers) {
    const resourceId = "resourceId" in trigger
      ? trigger.resourceId
      : "taskId" in trigger
        ? (trigger as { taskId: string }).taskId
        : "unknown";
    const header = buildOpenTag("event", { kind: trigger.kind, resource_id: resourceId });
    const body = renderTriggerEventBody(trigger);
    eventLines.push(header, ...body.split("\n"), buildCloseTag("event"));
  }
  const section = renderPromptSectionRaw("background_event_batch", eventLines) ?? "";
  const guidance = "后台任务已就绪。请阅读上述事件并继续完成当前任务；如果当前计划需要调整，请据此调整后续工具调用。";
  return section ? `${section}\n\n${guidance}` : guidance;
}
