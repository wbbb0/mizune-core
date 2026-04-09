import { getMainModelRefsForTier, getPrimaryModelProfile } from "#llm/shared/modelProfiles.ts";
import type { Relationship } from "#identity/relationship.ts";
import type { GenerationPromptHistoryMessage } from "./generationPromptBuilder.ts";
import type { GenerationRunnerDeps } from "./generationRunnerDeps.ts";
import type { GenerationRuntimeBatchMessage, GenerationSendTarget } from "./generationExecutor.ts";
import type { ToolsetView } from "#llm/tools/toolsets.ts";

export interface GenerationTurnPlannerInput {
  sessionId: string;
  relationship: Relationship;
  currentUser: Awaited<ReturnType<GenerationRunnerDeps["userStore"]["getByUserId"]>>;
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
  | { action: "continue"; resolvedModelRef: string[]; toolsetIds: string[] }
  | { action: "skip" };

// Evaluates turn-planner policy and applies reschedule side effects when needed.
export async function handleGenerationTurnPlanner(
  deps: Pick<GenerationRunnerDeps, "config" | "logger" | "llmClient" | "turnPlanner" | "debounceManager" | "historyCompressor" | "sessionManager" | "persistSession">,
  handlers: GenerationTurnPlannerHandlers,
  input: GenerationTurnPlannerInput
): Promise<GenerationTurnPlannerResult> {
  const {
    config,
    logger,
    llmClient,
    turnPlanner,
    debounceManager,
    historyCompressor,
    sessionManager,
    persistSession
  } = deps;
  const defaultModelRef = getMainModelRefsForTier(config, "small");

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

  const plannerProfile = getPrimaryModelProfile(config, config.llm.turnPlanner.modelRef);
  const hasEmojiWithoutGateVision = (
    input.batchMessages.some((message) => message.emojiIds.length > 0)
    || input.batchMessages.some((message) => (message.attachments ?? []).some((item) => item.semanticKind === "emoji"))
  ) && !plannerProfile?.supportsVision;
  if (hasEmojiWithoutGateVision) {
    logger.info(
      { sessionId: input.sessionId },
      "turn_planner_emoji_without_vision_continues_without_emoji_inputs"
    );
  }

  const planner = await turnPlanner.decide({
    sessionId: input.sessionId,
    chatType: input.sendTarget.chatType,
    relationship: input.relationship,
    currentUserSpecialRole: input.currentUser?.specialRole ?? null,
    recentMessages: input.historyForPrompt,
    availableToolsets: input.availableToolsets,
    abortSignal: input.abortSignal,
    batchMessages: input.batchMessages.map((message) => ({
      senderName: message.senderName,
      text: message.text,
      images: message.images,
      audioSources: message.audioSources,
      imageIds: message.imageIds,
      emojiIds: message.emojiIds,
      ...(message.attachments ? { attachments: message.attachments } : {}),
      forwardIds: message.forwardIds,
      replyMessageId: message.replyMessageId,
      mentionUserIds: message.mentionUserIds,
      mentionedAll: message.mentionedAll,
      mentionedSelf: message.isAtMentioned,
      timestampMs: message.receivedAt
    }))
  });

  if (input.abortSignal.aborted) {
    return { action: "skip" };
  }

  let finalAction: "continue" | "wait" | "skip" | "topic_switch" = "continue";
  let finalWaitPassCount: number | undefined;

  if (planner.topicDecision === "new_topic" && planner.replyDecision !== "wait") {
    const preservedMessageCount = input.batchMessages.length;
    const compressed = await historyCompressor.compactOldHistoryKeepingRecent(input.sessionId, preservedMessageCount);
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
    resolvedModelRef: getMainModelRefsForTier(config, planner.replyDecision === "reply_large" ? "large" : "small"),
    toolsetIds: planner.toolsetIds
  };
}
