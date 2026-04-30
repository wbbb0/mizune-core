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
  const system = buildBaseSystemLines({
    sessionMode: getSessionChatType(input.sessionId),
    ...(input.modeId ? { modeId: input.modeId } : {}),
    ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
    ...(input.visibleToolNames ? { visibleToolNames: input.visibleToolNames } : {}),
    ...(input.activeToolsets ? { activeToolsets: input.activeToolsets } : {}),
    persona: input.persona,
    npcProfiles: input.npcProfiles,
    participantProfiles: input.participantProfiles,
    userProfile: input.userProfile,
    ...(input.currentUserMemories ? { currentUserMemories: input.currentUserMemories } : {}),
    ...(input.globalRules ? { globalRules: input.globalRules } : {}),
    historySummary: input.historySummary,
    liveResources: input.liveResources,
    ...(input.toolsetRules ? { toolsetRules: input.toolsetRules } : {}),
    ...(input.scenarioStateLines ? { scenarioStateLines: input.scenarioStateLines } : {}),
    ...(input.modeProfile ? { modeProfile: input.modeProfile } : {}),
    ...(input.draftMode ? { draftMode: input.draftMode } : {}),
    ...(input.isInSetup ? { isInSetup: input.isInSetup } : {})
  }).join("\n");

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
    { role: "system", content: system },
    ...(input.lateSystemMessages ?? []).map((content) => ({ role: "system" as const, content })),
    ...((input.replayMessages ?? []) as LlmMessage[]),
    ...historyMessages,
    ...(input.batchMessages.length > 0
      ? [{
          role: "user" as const,
          content: batchContentBuilder(input.batchMessages, batchRenderContext, input.includeBatchMediaCaptions)
        }]
      : [])
  ];
}

export function buildScheduledTaskPrompt(input: ScheduledTaskPromptInput): LlmMessage[] {
  const system = [
    ...buildBaseSystemLines({
        sessionMode: input.targetContext.chatType,
        ...(input.modeId ? { modeId: input.modeId } : {}),
        ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
        ...(input.visibleToolNames ? { visibleToolNames: input.visibleToolNames } : {}),
        ...(input.activeToolsets ? { activeToolsets: input.activeToolsets } : {}),
      persona: input.persona,
      npcProfiles: input.npcProfiles,
      participantProfiles: input.participantProfiles,
      userProfile: input.userProfile,
      ...(input.currentUserMemories ? { currentUserMemories: input.currentUserMemories } : {}),
      ...(input.globalRules ? { globalRules: input.globalRules } : {}),
      historySummary: input.historySummary,
      liveResources: input.liveResources,
      ...(input.toolsetRules ? { toolsetRules: input.toolsetRules } : {}),
      ...(input.scenarioStateLines ? { scenarioStateLines: input.scenarioStateLines } : {}),
      ...(input.modeProfile ? { modeProfile: input.modeProfile } : {})
    }),
    ...buildScheduledTaskSystemLines({
      trigger: input.trigger,
      targetContext: input.targetContext
    })
  ].join("\n");

  const historyMessages: LlmMessage[] = input.recentMessages.map((message) => ({
    role: message.role,
    content: formatScheduledHistoryPromptMessage(
      message,
      input.modeId ? { modeId: input.modeId } : undefined
    )
  }));

  const triggerMessage = buildTriggerMessage(input);

  return [
    { role: "system", content: system },
    ...(input.lateSystemMessages ?? []).map((content) => ({ role: "system" as const, content })),
    ...((input.replayMessages ?? []) as LlmMessage[]),
    ...historyMessages,
    { role: "user", content: triggerMessage }
  ];
}

function buildTriggerMessage(input: ScheduledTaskPromptInput): string {
  if (input.trigger.kind === "scheduled_instruction") {
    return input.targetContext.chatType === "private"
      ? [
          `目标用户：${input.targetContext.senderName} (${input.targetContext.userId})`,
          `任务名称：${input.trigger.jobName}`,
          `任务指令：${input.trigger.taskInstruction}`
        ].join("\n")
      : [
          `目标群聊：${input.targetContext.groupId}`,
          `任务名称：${input.trigger.jobName}`,
          `任务指令：${input.trigger.taskInstruction}`
        ].join("\n");
  }

  if (input.trigger.kind === "comfy_task_completed") {
    return [
      `任务名称：${input.trigger.jobName}`,
      `任务说明：${input.trigger.taskInstruction}`,
      `模板：${input.trigger.templateId}`,
      `prompt：${input.trigger.positivePrompt}`,
      `比例：${input.trigger.aspectRatio} -> ${input.trigger.resolvedWidth}x${input.trigger.resolvedHeight}`,
      `Comfy prompt_id：${input.trigger.comfyPromptId}`,
      `workspace file_id：${input.trigger.workspaceFileIds.join("、") || "无"}`,
      `chat_file_path：${input.trigger.chatFilePaths.join("、") || "无"}`,
      `自动迭代进度：${input.trigger.autoIterationIndex}/${input.trigger.maxAutoIterations}`
    ].join("\n");
  }

  if (input.trigger.kind === "comfy_task_failed") {
    return [
      `任务名称：${input.trigger.jobName}`,
      `任务说明：${input.trigger.taskInstruction}`,
      `模板：${input.trigger.templateId}`,
      `prompt：${input.trigger.positivePrompt}`,
      `比例：${input.trigger.aspectRatio} -> ${input.trigger.resolvedWidth}x${input.trigger.resolvedHeight}`,
      `Comfy prompt_id：${input.trigger.comfyPromptId}`,
      `失败原因：${input.trigger.lastError}`,
      `自动迭代进度：${input.trigger.autoIterationIndex}/${input.trigger.maxAutoIterations}`
    ].join("\n");
  }

  if (input.trigger.kind === "terminal_session_closed") {
    return [
      `任务名称：${input.trigger.jobName}`,
      `任务说明：${input.trigger.taskInstruction}`,
      `resource_id：${input.trigger.resourceId}`,
      `命令：${input.trigger.command}`,
      `cwd：${input.trigger.cwd}`,
      `退出码：${input.trigger.exitCode ?? "无"}`,
      `信号：${input.trigger.signal ?? "无"}`,
      `输出是否截断：${input.trigger.outputTruncated ? "是" : "否"}`,
      `输出：\n${input.trigger.output || "(无输出)"}`
    ].join("\n");
  }

  // TODO: Add sensitive-input handling for password/token/code prompts before
  // storing or replaying user-provided secret values.
  return [
    `任务名称：${input.trigger.jobName}`,
    `任务说明：${input.trigger.taskInstruction}`,
    `resource_id：${input.trigger.resourceId}`,
    `命令：${input.trigger.command}`,
    `cwd：${input.trigger.cwd}`,
    `输入类型：${input.trigger.promptKind}`,
    `提示文本：${input.trigger.promptText}`,
    `最近输出：\n${input.trigger.outputTail || "(无输出)"}`
  ].join("\n");
}

export function buildSetupPrompt(input: SetupPromptInput): LlmMessage[] {
  const lastBatchMessage = input.batchMessages[input.batchMessages.length - 1];
  const batchRenderContext = {
    sessionId: input.sessionId,
    ...(lastBatchMessage?.userId ? { currentTriggerUserId: lastBatchMessage.userId } : {}),
    ...(lastBatchMessage?.senderName ? { currentTriggerSenderName: lastBatchMessage.senderName } : {})
  };
  const system = buildSetupSystemLines({
    sessionId: input.sessionId,
    ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
    persona: input.persona,
    phase: input.phase,
    missingFields: input.missingFields
  }).join("\n");

  const historyMessages: LlmMessage[] = input.recentMessages.map((message) => ({
    role: message.role,
    content: formatConversationHistoryPromptMessage(message)
  }));

  return [
    { role: "system", content: system },
    ...(input.lateSystemMessages ?? []).map((content) => ({ role: "system" as const, content })),
    ...((input.replayMessages ?? []) as LlmMessage[]),
    ...historyMessages,
    ...(input.batchMessages.length > 0
      ? [{
          role: "user" as const,
          content: buildProfileDraftBatchContent(input.batchMessages, batchRenderContext, input.includeBatchMediaCaptions)
        }]
      : [])
  ];
}
