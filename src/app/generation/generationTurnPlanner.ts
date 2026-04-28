import { getPrimaryModelProfile } from "#llm/shared/modelProfiles.ts";
import { getModelRefsForRole } from "#llm/shared/modelRouting.ts";
import type { Relationship } from "#identity/relationship.ts";
import type { GenerationPromptHistoryMessage } from "./generationPromptBuilder.ts";
import type { GenerationCurrentUser, GenerationTurnPlannerDeps } from "./generationRunnerDeps.ts";
import type { GenerationRuntimeBatchMessage, GenerationSendTarget } from "./generationExecutor.ts";
import type { ToolsetView } from "#llm/tools/toolsetCatalog.ts";
import type { TurnPlannerResult } from "#conversation/turnPlanner.ts";
import {
  collectVisualAttachmentFileIds,
  dedupeResolvedChatAttachments,
  isPendingChatAttachmentId
} from "#services/workspace/chatAttachments.ts";

export interface GenerationTurnPlannerInput {
  sessionId: string;
  relationship: Relationship;
  currentUser: GenerationCurrentUser;
  batchMessages: GenerationRuntimeBatchMessage[];
  availableToolsets: ToolsetView[];
  sendTarget: GenerationSendTarget;
  historyForPrompt: GenerationPromptHistoryMessage[];
  pendingReplyGateWaitPasses: number;
  abortSignal: AbortSignal;
}

export interface GenerationTurnPlannerHandlers {
  flushSession: (sessionId: string) => void;
}

export type GenerationTurnPlannerResult =
  | { action: "continue"; resolvedModelRef: string[]; toolsetIds: string[]; plannerDecision?: TurnPlannerResult | undefined }
  | { action: "skip" };

// Evaluates turn-planner policy and applies reschedule side effects when needed.
export async function handleGenerationTurnPlanner(
  deps: GenerationTurnPlannerDeps,
  handlers: GenerationTurnPlannerHandlers,
  input: GenerationTurnPlannerInput
): Promise<GenerationTurnPlannerResult> {
  const {
    config,
    logger,
    llmClient,
    sessionCaptioner,
    turnPlanner,
    debounceManager,
    historyCompressor,
    sessionManager,
    persistSession
  } = deps;
  const defaultModelRef = getModelRefsForRole(config, "main_small");

  if (input.batchMessages.length === 0 || !llmClient.isConfigured(defaultModelRef)) {
    return { action: "continue", resolvedModelRef: defaultModelRef, toolsetIds: input.availableToolsets.map((item) => item.id) };
  }

  if (!turnPlanner.isEnabled()) {
    return { action: "continue", resolvedModelRef: defaultModelRef, toolsetIds: input.availableToolsets.map((item) => item.id) };
  }

  const last = input.batchMessages[input.batchMessages.length - 1];
  if (!last) {
    return { action: "skip" };
  }

  if (input.batchMessages.some((message) => message.audioSources.length > 0)) {
    logger.info({ sessionId: input.sessionId }, "turn_planner_audio_todo_bypassed");
    return { action: "continue", resolvedModelRef: defaultModelRef, toolsetIds: input.availableToolsets.map((item) => item.id) };
  }

  const plannerProfile = getPrimaryModelProfile(config, getModelRefsForRole(config, "turn_planner"));
  const hasEmojiWithoutGateVision = (
    input.batchMessages.some((message) => message.emojiIds.some((fileId) => !isPendingChatAttachmentId(fileId)))
    || input.batchMessages.some((message) => collectVisualAttachmentFileIds(message.attachments, "emoji").length > 0)
  ) && !plannerProfile?.supportsVision;
  if (hasEmojiWithoutGateVision) {
    logger.info(
      { sessionId: input.sessionId },
      "turn_planner_emoji_without_vision_continues_without_emoji_inputs"
    );
  }

  const plannerBatchMessages = input.batchMessages.map((message) => {
    const attachments = dedupeResolvedChatAttachments(message.attachments ?? []);
    return {
      senderName: message.senderName,
      text: message.text,
      images: message.images,
      audioSources: message.audioSources,
      imageIds: message.imageIds.filter((fileId) => !isPendingChatAttachmentId(fileId)),
      emojiIds: message.emojiIds.filter((fileId) => !isPendingChatAttachmentId(fileId)),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(message.specialSegments && message.specialSegments.length > 0 ? { specialSegments: message.specialSegments } : {}),
      forwardIds: message.forwardIds,
      replyMessageId: message.replyMessageId,
      mentionUserIds: message.mentionUserIds,
      mentionedAll: message.mentionedAll,
      mentionedSelf: message.isAtMentioned,
      timestampMs: message.receivedAt
    };
  });

  const planner = await turnPlanner.decide({
    sessionId: input.sessionId,
    chatType: input.sendTarget.chatType,
    relationship: input.relationship,
    currentUserSpecialRole: input.currentUser?.specialRole ?? null,
    recentMessages: input.historyForPrompt,
    availableToolsets: input.availableToolsets,
    abortSignal: input.abortSignal,
    batchMessages: plannerBatchMessages
  });

  if (input.abortSignal.aborted) {
    return { action: "skip" };
  }

  let finalAction: "continue" | "wait" | "skip" | "topic_switch" = "continue";
  let finalWaitPassCount: number | undefined;

  if (planner.topicDecision === "new_topic" && planner.replyDecision !== "wait") {
    const preservedMessageCount = input.batchMessages.length;
    const compressed = await historyCompressor.compactOldHistoryKeepingRecent(input.sessionId, preservedMessageCount, {
      triggerReason: "turn_planner_topic_switch"
    });
    logger.info(
      {
        sessionId: input.sessionId,
        preservedMessageCount,
        compressed,
        ...(planner.reason ? { reason: planner.reason } : {})
      },
      "turn_planner_topic_switch_compacted"
    );
    if (compressed) {
      persistSession(input.sessionId, "turn_planner_topic_switch_compacted");
    }
    finalAction = "topic_switch";
  }

  if (planner.replyDecision === "wait") {
    const nextWaitPassCount = input.pendingReplyGateWaitPasses + 1;
    if (nextWaitPassCount > config.llm.turnPlanner.maxWaitPasses) {
      logger.info(
        {
          sessionId: input.sessionId,
          pendingReplyGateWaitPasses: input.pendingReplyGateWaitPasses,
          maxWaitPasses: config.llm.turnPlanner.maxWaitPasses,
          ...(planner.reason ? { reason: planner.reason } : {})
        },
        "turn_planner_wait_limit_reached"
      );
    } else {
      sessionManager.requeuePendingMessages(input.sessionId, input.batchMessages, nextWaitPassCount);
      debounceManager.schedule(input.sessionId, () => {
        handlers.flushSession(input.sessionId);
      }, {
        reason: "gate_wait",
        multiplierOverride: config.conversation.debounce.plannerWaitMultiplier
      });
      persistSession(input.sessionId, "turn_planner_wait_rescheduled");
      logger.info(
        {
          sessionId: input.sessionId,
          waitPassCount: nextWaitPassCount,
          plannerWaitMultiplier: config.conversation.debounce.plannerWaitMultiplier,
          ...(planner.reason ? { reason: planner.reason } : {})
        },
        "reply_deferred_by_turn_planner_wait"
      );
      finalAction = "wait";
      finalWaitPassCount = nextWaitPassCount;
    }
  }

  if (typeof (sessionManager as { appendInternalTranscript?: unknown }).appendInternalTranscript === "function") {
    sessionManager.appendInternalTranscript(input.sessionId, {
      kind: "gate_decision",
      llmVisible: false,
      action: finalAction,
      reason: planner.reason ?? null,
      ...(planner.reasoningContent ? { reasoningContent: planner.reasoningContent } : {}),
      ...(typeof finalWaitPassCount === "number" ? { waitPassCount: finalWaitPassCount } : {}),
      replyDecision: planner.replyDecision,
      topicDecision: planner.topicDecision,
      ...(planner.requiredCapabilities.length > 0 ? { requiredCapabilities: planner.requiredCapabilities } : {}),
      ...(planner.contextDependencies.length > 0 ? { contextDependencies: planner.contextDependencies } : {}),
      ...(planner.recentDomainReuse.length > 0 ? { recentDomainReuse: planner.recentDomainReuse } : {}),
      ...(planner.followupMode !== "none" ? { followupMode: planner.followupMode } : {}),
      ...(planner.toolsetIds.length > 0 ? { toolsetIds: planner.toolsetIds } : {}),
      timestampMs: Date.now()
    });
    persistSession(input.sessionId, `turn_planner_${finalAction}_recorded`);
  }

  if (finalAction === "wait") {
    return { action: "skip" };
  }

  return {
    action: "continue",
    resolvedModelRef: getModelRefsForRole(
      config,
      planner.replyDecision === "reply_large" ? "main_large" : "main_small"
    ),
    toolsetIds: planner.toolsetIds,
    plannerDecision: planner
  };
}
