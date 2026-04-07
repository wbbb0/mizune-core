import { getMainModelRefsForTier, getPrimaryModelProfile } from "#llm/shared/modelProfiles.ts";
import type { Relationship } from "#identity/relationship.ts";
import type { GenerationPromptHistoryMessage } from "./generationPromptBuilder.ts";
import type { GenerationRunnerDeps } from "./generationRunnerDeps.ts";
import type { GenerationRuntimeBatchMessage, GenerationSendTarget } from "./generationExecutor.ts";

export interface GenerationReplyGateInput {
  sessionId: string;
  relationship: Relationship;
  currentUser: Awaited<ReturnType<GenerationRunnerDeps["userStore"]["getByUserId"]>>;
  batchMessages: GenerationRuntimeBatchMessage[];
  sendTarget: GenerationSendTarget;
  historyForPrompt: GenerationPromptHistoryMessage[];
  pendingReplyGateWaitPasses: number;
  abortSignal: AbortSignal;
}

export interface GenerationReplyGateHandlers {
  flushSession: (sessionId: string) => void;
}

export type GenerationReplyGateResult =
  | { action: "continue"; resolvedModelRef: string[] }
  | { action: "skip" };

// Evaluates reply-gate policy and applies reschedule side effects when needed.
export async function handleGenerationReplyGate(
  deps: Pick<GenerationRunnerDeps, "config" | "logger" | "llmClient" | "replyGate" | "debounceManager" | "historyCompressor" | "sessionManager" | "persistSession">,
  handlers: GenerationReplyGateHandlers,
  input: GenerationReplyGateInput
): Promise<GenerationReplyGateResult> {
  const {
    config,
    logger,
    llmClient,
    replyGate,
    debounceManager,
    historyCompressor,
    sessionManager,
    persistSession
  } = deps;
  const defaultModelRef = getMainModelRefsForTier(config, "small");

  if (input.batchMessages.length === 0 || !llmClient.isConfigured(defaultModelRef)) {
    return { action: "continue", resolvedModelRef: defaultModelRef };
  }

  if (!replyGate.isEnabled()) {
    return { action: "continue", resolvedModelRef: defaultModelRef };
  }

  const last = input.batchMessages[input.batchMessages.length - 1];
  if (!last) {
    return { action: "skip" };
  }

  if (input.batchMessages.some((message) => message.audioSources.length > 0)) {
    logger.info({ sessionId: input.sessionId }, "reply_gate_audio_todo_bypassed");
    return { action: "continue", resolvedModelRef: defaultModelRef };
  }

  const replyGateProfile = getPrimaryModelProfile(config, config.llm.replyGate.modelRef);
  const hasEmojiWithoutGateVision = (
    input.batchMessages.some((message) => message.emojiIds.length > 0)
    || input.batchMessages.some((message) => (message.attachments ?? []).some((item) => item.semanticKind === "emoji"))
  ) && !replyGateProfile?.supportsVision;
  if (hasEmojiWithoutGateVision) {
    logger.info(
      { sessionId: input.sessionId },
      "reply_gate_emoji_without_vision_continues_without_emoji_inputs"
    );
  }

  const gate = await replyGate.decide({
    sessionId: input.sessionId,
    chatType: input.sendTarget.chatType,
    relationship: input.relationship,
    currentUserSpecialRole: input.currentUser?.specialRole ?? null,
    recentMessages: input.historyForPrompt,
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

  const recordGateDecision = (item: {
    action: "continue" | "wait" | "skip" | "topic_switch";
    reason: string | null;
    waitPassCount?: number;
  }) => {
    if (typeof (sessionManager as { appendInternalTranscript?: unknown }).appendInternalTranscript !== "function") {
      return;
    }
    sessionManager.appendInternalTranscript(input.sessionId, {
      kind: "gate_decision",
      llmVisible: false,
      action: item.action,
      reason: item.reason,
      ...(typeof item.waitPassCount === "number" ? { waitPassCount: item.waitPassCount } : {}),
      replyDecision: gate.replyDecision,
      topicDecision: gate.topicDecision,
      timestampMs: Date.now()
    });
    persistSession(input.sessionId, `reply_gate_${item.action}_recorded`);
  };

  if (gate.topicDecision === "new_topic" && gate.replyDecision !== "wait") {
    const preservedMessageCount = input.batchMessages.length;
    const compressed = await historyCompressor.compactOldHistoryKeepingRecent(input.sessionId, preservedMessageCount);
    logger.info(
      {
        sessionId: input.sessionId,
        preservedMessageCount,
        compressed,
        ...(gate.reason ? { reason: gate.reason } : {})
      },
      "reply_gate_topic_switch_compacted"
    );
    if (compressed) {
      persistSession(input.sessionId, "reply_gate_topic_switch_compacted");
    }
    recordGateDecision({
      action: "topic_switch",
      reason: gate.reason ?? null
    });
  }

  if (gate.replyDecision === "wait") {
    const nextWaitPassCount = input.pendingReplyGateWaitPasses + 1;
    if (nextWaitPassCount > config.llm.replyGate.maxWaitPasses) {
      logger.info(
        {
          sessionId: input.sessionId,
          pendingReplyGateWaitPasses: input.pendingReplyGateWaitPasses,
          maxWaitPasses: config.llm.replyGate.maxWaitPasses,
          ...(gate.reason ? { reason: gate.reason } : {})
        },
        "reply_gate_wait_limit_reached"
      );
      return {
        action: "continue",
        resolvedModelRef: defaultModelRef
      };
    }

    sessionManager.requeuePendingMessages(input.sessionId, input.batchMessages, nextWaitPassCount);
    debounceManager.schedule(input.sessionId, () => {
      handlers.flushSession(input.sessionId);
    }, {
      reason: "gate_wait",
      multiplierOverride: config.conversation.debounce.gateWaitMultiplier
    });
    persistSession(input.sessionId, "reply_gate_wait_rescheduled");
    logger.info(
      {
        sessionId: input.sessionId,
        waitPassCount: nextWaitPassCount,
        gateWaitMultiplier: config.conversation.debounce.gateWaitMultiplier,
        ...(gate.reason ? { reason: gate.reason } : {})
      },
      "reply_deferred_by_gate_wait"
    );
    recordGateDecision({
      action: "wait",
      reason: gate.reason ?? null,
      waitPassCount: nextWaitPassCount
    });
    return { action: "skip" };
  }

  recordGateDecision({
    action: "continue",
    reason: gate.reason ?? null
  });

  return {
    action: "continue",
    resolvedModelRef: getMainModelRefsForTier(config, gate.replyDecision === "reply_large" ? "large" : "small")
  };
}
