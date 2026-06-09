import { buildOpenTag, buildCloseTag } from "#utils/structuredEnvelope.ts";
import type { LlmMessage } from "../llmClient.ts";
import {
  buildUserBatchContent,
  buildProfileDraftBatchContent,
} from "../prompts/trigger-batch.prompt.ts";
import {
  buildBaseSystemSections,
  buildScheduledTaskSystemSections,
  buildSetupSystemSections
} from "../prompts/chat-system.prompt.ts";
import {
  formatConversationHistoryPromptMessage,
  formatScheduledHistoryPromptMessage
} from "../prompts/history-message.prompt.ts";
import { getSessionChatType } from "#conversation/session/sessionIdentity.ts";
import type { PromptInput, ScheduledTaskPromptInput, SetupPromptInput } from "./promptTypes.ts";
import type { AssetHandle } from "#llm/tools/core/fileHandle.ts";
import type { InlineSessionTriggerExecution } from "#conversation/session/sessionTypes.ts";
import { renderPromptSection, renderPromptSectionRaw, type PromptSection, type PromptSectionPlacement } from "../prompts/prompt-section.ts";

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
  const baseSystemSections = buildBaseSystemSections({
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
    ...(input.scenarioSetupRequirementLines ? { scenarioSetupRequirementLines: input.scenarioSetupRequirementLines } : {}),
    ...(input.modeProfile ? { modeProfile: input.modeProfile } : {}),
    ...(input.draftMode ? { draftMode: input.draftMode } : {}),
    ...(input.isInSetup ? { isInSetup: input.isInSetup } : {})
  });
  const systemMessages = buildSystemMessages(baseSystemSections);

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
  const userBatchContent = input.batchMessages.length > 0
    ? appendCurrentTurnDirectives(
        batchContentBuilder(input.batchMessages, batchRenderContext, input.includeBatchMediaCaptions),
        input.currentTurnDirectives
      )
    : renderCurrentTurnDirectives(input.currentTurnDirectives);

  return [
    ...systemMessages,
    ...(input.lateSystemMessages ?? []).map((content) => ({ role: "system" as const, content })),
    ...((input.replayMessages ?? []) as LlmMessage[]),
    ...historyMessages,
    ...(userBatchContent
      ? [{
          role: "user" as const,
          content: userBatchContent
        }]
      : []),
  ];
}

export function buildScheduledTaskPrompt(
  input: ScheduledTaskPromptInput & { inlineBatchMessage?: string | undefined }
): LlmMessage[] {
  const taskTracker = shouldIncludeTaskTrackerForScheduledTrigger(input.trigger)
    ? input.taskTracker
    : undefined;
  const baseSystemSections = buildBaseSystemSections({
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
  const scheduledSystemSections = buildScheduledTaskSystemSections({
    trigger: input.trigger,
    targetContext: input.targetContext
  });
  const systemMessages = buildSystemMessages(baseSystemSections, scheduledSystemSections);

  const historyMessages: LlmMessage[] = input.recentMessages.map((message) => ({
    role: message.role,
    content: formatScheduledHistoryPromptMessage(
      message,
      input.modeId ? { modeId: input.modeId } : undefined
    )
  }));

  const triggerMessage = appendCurrentTurnDirectives(
    input.inlineBatchMessage ?? buildTriggerMessage(input),
    input.currentTurnDirectives
  );

  return [
    ...systemMessages,
    ...(input.lateSystemMessages ?? []).map((content) => ({ role: "system" as const, content })),
    ...((input.replayMessages ?? []) as LlmMessage[]),
    ...historyMessages,
    { role: "user", content: triggerMessage }
  ];
}

function buildSystemMessages(
  baseSections: PromptSection[],
  extraVolatileSections: PromptSection[] = []
): LlmMessage[] {
  const messages: LlmMessage[] = [];
  const allSections = [...baseSections, ...extraVolatileSections];
  for (const placement of SYSTEM_MESSAGE_PLACEMENT_ORDER) {
    const content = allSections
      .filter((section) => section.placement === placement)
      .map((section) => section.content)
      .join("\n");
    if (content.length > 0) {
      messages.push({ role: "system", content });
    }
  }
  return messages;
}

const SYSTEM_MESSAGE_PLACEMENT_ORDER: PromptSectionPlacement[] = [
  "stable_system",
  "volatile_system",
  "capability_system"
];

function appendCurrentTurnDirectives(content: LlmMessage["content"], directives: string[] | undefined): LlmMessage["content"] {
  const directiveSection = renderCurrentTurnDirectives(directives);
  if (!directiveSection) {
    return content;
  }
  if (typeof content === "string") {
    return `${content}\n${directiveSection}`;
  }
  return [...content, { type: "text", text: directiveSection }];
}

function renderCurrentTurnDirectives(directives: string[] | undefined): string | null {
  return renderPromptSection("current_turn_directives", directives ?? []);
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
  const setupSystemSections = buildSetupSystemSections({
    sessionId: input.sessionId,
    ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
    persona: input.persona,
    phase: input.phase,
    missingFields: input.missingFields
  });
  const systemMessages = buildSystemMessages(setupSystemSections);

  const historyMessages: LlmMessage[] = input.recentMessages.map((message) => ({
    role: message.role,
    content: formatConversationHistoryPromptMessage(message)
  }));
  const userBatchContent = input.batchMessages.length > 0
    ? appendCurrentTurnDirectives(
        buildProfileDraftBatchContent(input.batchMessages, batchRenderContext, input.includeBatchMediaCaptions),
        input.currentTurnDirectives
      )
    : renderCurrentTurnDirectives(input.currentTurnDirectives);

  return [
    ...systemMessages,
    ...(input.lateSystemMessages ?? []).map((content) => ({ role: "system" as const, content })),
    ...((input.replayMessages ?? []) as LlmMessage[]),
    ...historyMessages,
    ...(userBatchContent
      ? [{
          role: "user" as const,
          content: userBatchContent
        }]
      : []),
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
