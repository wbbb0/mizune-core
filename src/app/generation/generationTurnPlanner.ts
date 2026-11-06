import { projectPlannerTaskEvidence } from "./plannerTaskEvidence.ts";
import { mustReplyToPlannerBatch } from "#conversation/turnPlanner/result.ts";
import { isSkillRuntimeAllowedForSession, type SkillSessionContext } from "../../skills/skillPolicy.ts";
import { getSkillStore } from '../../skills/skillStore.ts';
import { getModelRefsForRole } from "#llm/shared/modelRouting.ts";
import type { Relationship } from "#identity/relationship.ts";
import type { GenerationPromptHistoryMessage } from "./generationPromptBuilder.ts";
import type { GenerationCurrentUser, GenerationTurnPlannerDeps } from "./generationRunnerDeps.ts";
import type { GenerationRuntimeBatchMessage, GenerationSendTarget } from "./generationExecutor.ts";
import type { ToolsetView } from "#llm/tools/toolsetCatalog.ts";
import { describePlannerOperations, projectPlannerBatchMessages, recordGenerationPlannerDecision } from "./generationModelPlanner.ts";
import type { TurnPlannerResult } from "#conversation/turnPlanner/types.ts";
import type { TurnPlannerTaskContext } from "#conversation/taskTracker/taskTrackerPlannerContext.ts";
import { getTurnPlannerReasons, resolveTurnPlannerRequirements, type TopicCompressionCandidate } from "#conversation/turnPlannerPolicy.ts";


export interface GenerationTurnPlannerInput extends SkillSessionContext {
  sessionId: string;
  relationship: Relationship;
  currentUser: GenerationCurrentUser;
  modeId?: string | null;
  modeSignalLine?: string | null;
  batchMessages: GenerationRuntimeBatchMessage[];
  availableToolsets: ToolsetView[];
  taskContext?: TurnPlannerTaskContext | null | undefined;
  taskSummary?: string | null | undefined;
  topicCompressionCandidate?: TopicCompressionCandidate | null | undefined;
  sendTarget: GenerationSendTarget;
  historyForPrompt: GenerationPromptHistoryMessage[];
  pendingReplyGateWaitPasses: number;
  abortSignal: AbortSignal;
}

export interface GenerationTurnPlannerHandlers {
  flushSession: (sessionId: string) => void;
}

export type GenerationTurnPlannerResult =
  | {
      action: "continue";
      resolvedModelRef: string[];
      toolsetIds: string[];
      plannerDecision?: TurnPlannerResult | undefined;
      topicSwitchCompression?: { preservedMessageCount: number } | undefined;
    }
  | { action: "skip"; plannerDecision?: TurnPlannerResult | undefined };

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
    turnPlanner,
    debounceManager,
    sessionManager,
    persistSession
  } = deps;
  const defaultModelRef = getModelRefsForRole(config, "main_small");
  const continueWithoutPlanner = (reason: string): GenerationTurnPlannerResult => {
    logger.info({ sessionId: input.sessionId, reason, inputTokens: 0, outputTokens: 0, durationMs: 0 }, "turn_planner_skipped");
    return { action: "continue", resolvedModelRef: defaultModelRef, toolsetIds: input.availableToolsets.map((item) => item.id) };
  };

  if (input.batchMessages.length === 0 || !llmClient.isConfigured(defaultModelRef)) {
    return continueWithoutPlanner("empty_batch_or_model_unavailable");
  }

  if (!turnPlanner.isEnabled()) {
    return continueWithoutPlanner("disabled");
  }

  const last = input.batchMessages[input.batchMessages.length - 1];
  if (!last) {
    return { action: "skip" };
  }

  if (input.batchMessages.some((message) => message.audioSources.length > 0)) {
    logger.info({ sessionId: input.sessionId }, "turn_planner_audio_todo_bypassed");
    return continueWithoutPlanner("audio_pending_transcription");
  }

  const selectableSkills = (
    config.skills.enabled
    && config.skills.plannerSelectionEnabled
    && isSkillRuntimeAllowedForSession(input.modeId, input.operationMode, input)
  )
    ? getSkillStore(config).list().filter(skill => skill.effectiveAvailable)
    : [];
  const plannerBatchMessages = projectPlannerBatchMessages(input.batchMessages);

  const mustReply = mustReplyToPlannerBatch(input.sendTarget.chatType,
    input.batchMessages.map(message => ({ ...message, mentionedSelf: message.isAtMentioned })));
  const requirements = resolveTurnPlannerRequirements(config, {
    canSkipReply: !mustReply,
    pendingWaitPasses: input.pendingReplyGateWaitPasses,
    availableToolsetCount: input.availableToolsets.length,
    availableSkillCount: selectableSkills.length,
    taskContext: input.taskContext,
    topicCompressionCandidate: input.topicCompressionCandidate
  });
  const callReasons = getTurnPlannerReasons(requirements);
  if (callReasons.length === 0) return continueWithoutPlanner("no_required_decisions");
  logger.info({ sessionId: input.sessionId, callReasons, topicCompressionCandidate: input.topicCompressionCandidate }, "turn_planner_required");
  const taskEvidence = await projectPlannerTaskEvidence(deps.contentSafetyService, {
    sessionId: input.sessionId, source: "turn_planner_task_evidence", taskContext: input.taskContext,
    taskSummary: input.taskSummary, abortSignal: input.abortSignal
  });
  let planner = await turnPlanner.decide({
    requirements,
    availableSkills: requirements.skillSelection ? selectableSkills.map(({ id, name, description }) => ({ id, name, description })) : [],
    sessionId: input.sessionId,
    chatType: input.sendTarget.chatType,
    relationship: input.relationship,
    currentUserSpecialRole: input.currentUser?.specialRole ?? null,
    modeId: input.modeId ?? null,
    modeSignalLine: input.modeSignalLine ?? null,
    recentMessages: input.historyForPrompt,
    availableToolsets: requirements.toolSelection ? input.availableToolsets : [],
    operationSummary: describePlannerOperations(config, input.availableToolsets),
    taskContext: taskEvidence.taskContext,
    taskSummary: taskEvidence.taskSummary,
    abortSignal: input.abortSignal,
    batchMessages: plannerBatchMessages
  });

  if (input.abortSignal.aborted) {
    return { action: "skip" };
  }

  let finalAction: "continue" | "wait" | "skip" | "topic_switch" = "continue";
  let finalWaitPassCount: number | undefined;
  let topicSwitchCompression: { preservedMessageCount: number } | undefined;

  if (planner.replyDecision === "no_reply" && mustReply) {
    logger.info(
      {
        sessionId: input.sessionId,
        reason: planner.reason || "explicit trigger no_reply not allowed"
      },
      "turn_planner_no_reply_coerced_to_reply"
    );
    planner = {
      ...planner,
      replyDecision: "reply",
      topicDecision: "continue_topic",
      toolsetIds: []
    };
  }

  if (planner.replyDecision === "no_reply") {
    logger.info(
      {
        sessionId: input.sessionId,
        ...(planner.reason ? { reason: planner.reason } : {})
      },
      "reply_skipped_by_turn_planner_no_reply"
    );
    finalAction = "skip";
  }

  if (requirements.topicSwitch && finalAction === "continue" && planner.topicDecision === "new_topic" && planner.replyDecision !== "wait") {
    const preservedMessageCount = input.batchMessages.length;
    logger.info(
      {
        sessionId: input.sessionId,
        preservedMessageCount,
        ...(planner.reason ? { reason: planner.reason } : {})
      },
      "turn_planner_topic_switch_requested"
    );
    finalAction = "topic_switch";
    topicSwitchCompression = { preservedMessageCount };
  }

  if (requirements.semanticWait && planner.replyDecision === "wait") {
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

  recordGenerationPlannerDecision(deps, {
    sessionId: input.sessionId, planner, action: finalAction, plannerReasons: callReasons,
    topicDecisionEvaluated: requirements.topicSwitch,
    ...(finalWaitPassCount !== undefined ? { waitPassCount: finalWaitPassCount } : {})
  });

  if (finalAction === "wait" || finalAction === "skip") {
    return { action: "skip", plannerDecision: planner };
  }

  return {
    action: "continue",
    resolvedModelRef: getModelRefsForRole(
      config,
      requirements.modelSelection && (planner.modelTier === "large" || planner.modelSelectionStatus === "undetermined") ? "main_large" : "main_small"
    ),
    toolsetIds: requirements.toolSelection ? planner.toolsetIds : input.availableToolsets.map((item) => item.id),
    plannerDecision: planner,
    ...(topicSwitchCompression ? { topicSwitchCompression } : {})
  };
}
