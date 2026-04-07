import type { LlmMessage } from "../llmClient.ts";
import {
  buildUserBatchContent,
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
    ...(input.userProfile.userId ?? lastBatchMessage?.userId
      ? { currentTriggerUserId: input.userProfile.userId ?? lastBatchMessage?.userId ?? "" }
      : {}),
    ...(input.userProfile.senderName ?? lastBatchMessage?.senderName
      ? { currentTriggerSenderName: input.userProfile.senderName ?? lastBatchMessage?.senderName ?? "" }
      : {})
  };
  const system = buildBaseSystemLines({
    ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
    ...(input.visibleToolNames ? { visibleToolNames: input.visibleToolNames } : {}),
    persona: input.persona,
    npcProfiles: input.npcProfiles,
    participantProfiles: input.participantProfiles,
    userProfile: input.userProfile,
    globalMemories: input.globalMemories,
    historySummary: input.historySummary,
    recentToolEvents: input.recentToolEvents,
    runtimeResources: input.runtimeResources
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
          content: buildUserBatchContent(input.batchMessages, batchRenderContext, input.includeBatchMediaCaptions)
        }]
      : [])
  ];
}

export function buildScheduledTaskPrompt(input: ScheduledTaskPromptInput): LlmMessage[] {
  const system = [
    ...buildBaseSystemLines({
        ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
        ...(input.visibleToolNames ? { visibleToolNames: input.visibleToolNames } : {}),
      persona: input.persona,
      npcProfiles: input.npcProfiles,
      participantProfiles: input.participantProfiles,
      userProfile: input.userProfile,
      globalMemories: input.globalMemories,
      historySummary: input.historySummary,
      recentToolEvents: input.recentToolEvents,
      runtimeResources: input.runtimeResources
    }),
    ...buildScheduledTaskSystemLines({
      trigger: input.trigger,
      targetContext: input.targetContext
    })
  ].join("\n");

  const historyMessages: LlmMessage[] = input.recentMessages.map((message) => ({
    role: message.role,
    content: formatScheduledHistoryPromptMessage(message)
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
          "请现在执行这项计划任务。",
          "如果任务本身需要查资料、看图或调用其他工具，请先完成这些内部步骤，再决定是否给目标私聊用户发消息。",
          `目标用户：${input.targetContext.senderName} (${input.targetContext.userId})`,
          `任务名称：${input.trigger.jobName}`,
          `任务指令：${input.trigger.taskInstruction}`
        ].join("\n")
      : [
          "请现在执行这项计划任务。",
          "如果任务本身需要查资料、看图或调用其他工具，请先完成这些内部步骤，再决定是否给目标群聊发消息。",
          `目标群聊：${input.targetContext.groupId}`,
          `任务名称：${input.trigger.jobName}`,
          `任务指令：${input.trigger.taskInstruction}`
        ].join("\n");
  }

  if (input.trigger.kind === "comfy_task_completed") {
    return [
      "你之前发起的 ComfyUI 任务已经完成。",
      "这不是用户新发来的消息，而是系统把完成结果交还给你处理。",
      `workspace asset_id：${input.trigger.workspaceAssetIds.join("、") || "无"}`,
      `workspace 路径：${input.trigger.workspacePaths.join("、") || "无"}`,
      "请你自己判断接下来要做什么：可以先看图、直接发图、继续改 prompt 再生成，或结束本轮。"
    ].join("\n");
  }

  return [
    "你之前发起的 ComfyUI 任务失败了。",
    "这不是用户新发来的消息，而是系统把失败结果交还给你处理。",
    `失败原因：${input.trigger.lastError}`,
    "请你自己判断接下来要做什么：可以向用户简短说明，也可以调整 prompt 再次生成。"
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
          content: buildUserBatchContent(input.batchMessages, batchRenderContext, input.includeBatchMediaCaptions)
        }]
      : [])
  ];
}
