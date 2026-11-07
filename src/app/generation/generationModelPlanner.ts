import { getModelRefsForRole } from "#llm/shared/modelRouting.ts";
import { getBuiltinToolDescriptors } from "#llm/tools/toolRegistry.ts";
import { describeToolModelPolicy } from "#llm/tools/core/toolModelPolicy.ts";
import type { ToolsetView } from "#llm/tools/toolsetCatalog.ts";
import { resolveTurnPlannerRequirements } from "#conversation/turnPlannerPolicy.ts";
import type { TurnPlannerInput, TurnPlannerResult } from "#conversation/turnPlanner/types.ts";
import type { GenerationTurnPlannerDeps } from "./generationRunnerDeps.ts";
import { projectPlannerTaskEvidence } from "./plannerTaskEvidence.ts";
import type { GenerationRuntimeBatchMessage } from "./generationExecutor.ts";
import { dedupeResolvedChatAttachments, isPendingChatAttachmentId } from "#services/workspace/chatAttachments.ts";

type ModelPlannerDeps = Pick<GenerationTurnPlannerDeps, "config" | "logger" | "llmClient" | "turnPlanner" | "sessionManager" | "persistSession" | "contentSafetyService">;
export type GenerationModelPlannerInput = Omit<TurnPlannerInput, "requirements" | "availableToolsets" | "availableSkills"> & {
  availableToolsets: ToolsetView[];
  entryPoint: "setup" | "continuation" | "internal_trigger" | "inline_trigger";
};

export function describePlannerOperations(config: ModelPlannerDeps["config"], toolsets: ToolsetView[]): string[] {
  const names = new Set(toolsets.flatMap(toolset => toolset.toolNames));
  return Array.from(new Set(getBuiltinToolDescriptors(config).filter(tool => names.has(tool.definition.function.name)).map(tool => describeToolModelPolicy(tool.modelPolicy))));
}

export function projectPlannerBatchMessages(messages: GenerationRuntimeBatchMessage[]): TurnPlannerInput["batchMessages"] {
  return messages.map(message => {
    const attachments = dedupeResolvedChatAttachments(message.attachments ?? []);
    return {
      senderName: message.senderName, text: message.text,
      ...(message.contentParts?.length ? { contentParts: message.contentParts } : {}),
      images: message.images, audioSources: message.audioSources, audioIds: message.audioIds,
      imageIds: message.imageIds.filter(id => !isPendingChatAttachmentId(id)),
      emojiIds: message.emojiIds.filter(id => !isPendingChatAttachmentId(id)),
      ...(attachments.length ? { attachments } : {}),
      ...(message.messageFiles?.length ? { messageFiles: message.messageFiles } : {}),
      ...(message.specialSegments?.length ? { specialSegments: message.specialSegments } : {}),
      forwardIds: message.forwardIds, replyMessageId: message.replyMessageId, mentionUserIds: message.mentionUserIds,
      mentionedAll: message.mentionedAll, mentionedSelf: message.isAtMentioned, timestampMs: message.receivedAt
    };
  });
}

/** The same transcript contract is used by full planning and model-only entry points. */
export function recordGenerationPlannerDecision(deps: Pick<ModelPlannerDeps, "sessionManager" | "persistSession">, input: {
  sessionId: string;
  planner: TurnPlannerResult;
  action: "continue" | "wait" | "skip" | "topic_switch";
  plannerReasons: string[];
  topicDecisionEvaluated?: boolean;
  waitPassCount?: number;
}): void {
  if (typeof deps.sessionManager.appendInternalTranscript !== "function") return;
  const { planner } = input;
  deps.sessionManager.appendInternalTranscript(input.sessionId, {
    kind: "gate_decision", llmVisible: false, action: input.action, reason: planner.reason ?? null,
    ...(planner.reasoningContent ? { reasoningContent: planner.reasoningContent } : {}),
    ...(input.waitPassCount !== undefined ? { waitPassCount: input.waitPassCount } : {}),
    replyDecision: planner.replyDecision,
    ...(planner.taskBasis ? { taskBasis: planner.taskBasis } : {}),
    ...(planner.modelTier ? { modelTier: planner.modelTier } : {}),
    ...(planner.modelSelectionStatus ? { modelSelectionStatus: planner.modelSelectionStatus } : {}),
    ...(planner.undeterminedQuestions?.length ? { undeterminedQuestions: planner.undeterminedQuestions } : {}),
    ...(input.topicDecisionEvaluated ? { topicDecision: planner.topicDecision } : {}),
    plannerReasons: input.plannerReasons,
    ...(planner.metrics ? { plannerMetrics: planner.metrics } : {}),
    ...(planner.requiredCapabilities.length ? { requiredCapabilities: planner.requiredCapabilities } : {}),
    ...(planner.contextDependencies.length ? { contextDependencies: planner.contextDependencies } : {}),
    ...(planner.recentDomainReuse.length ? { recentDomainReuse: planner.recentDomainReuse } : {}),
    ...(planner.followupMode !== "none" ? { followupMode: planner.followupMode } : {}),
    ...(planner.toolsetIds.length ? { toolsetIds: planner.toolsetIds } : {}), timestampMs: Date.now()
  });
  deps.persistSession(input.sessionId, `turn_planner_${input.action}_recorded`);
}

/** Plan once per generation entry; never run reply gating or mutate task/topic state here. */
export async function planGenerationModel(deps: ModelPlannerDeps, input: GenerationModelPlannerInput): Promise<{
  resolvedModelRef: string[];
  plannerDecision?: TurnPlannerResult;
}> {
  input.abortSignal?.throwIfAborted();
  const small = getModelRefsForRole(deps.config, "main_small");
  const needsModelSelection = resolveTurnPlannerRequirements(deps.config, { canSkipReply: false, pendingWaitPasses: 0, availableToolsetCount: 0 }).modelSelection;
  if (!needsModelSelection || !deps.config.llm.enabled || !deps.config.llm.turnPlanner.enabled || !deps.turnPlanner.isEnabled() || !deps.llmClient.isConfigured(small)) {
    deps.logger.info({ sessionId: input.sessionId, reason: !needsModelSelection ? "equivalent_or_missing_large_route" : "disabled_or_unavailable", entryPoint: input.entryPoint, inputTokens: 0, outputTokens: 0, durationMs: 0 }, "turn_planner_skipped");
    return { resolvedModelRef: small };
  }
  const { entryPoint, availableToolsets, ...evidence } = input;
  const projected = await projectPlannerTaskEvidence(deps.contentSafetyService, {
    sessionId: input.sessionId, source: `model_planner_${entryPoint}`, taskSummary: input.taskSummary,
    taskContext: input.taskContext, recentMessages: input.recentMessages, batchMessages: input.batchMessages,
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
  });
  deps.logger.info({ sessionId: input.sessionId, callReasons: ["modelSelection"], entryPoint }, "turn_planner_required");
  const planner = await deps.turnPlanner.decide({
    ...evidence, ...projected, operationSummary: input.operationSummary ?? describePlannerOperations(deps.config, availableToolsets),
    availableToolsets: [], requirements: { modelSelection: true, replyGate: false, semanticWait: false, topicSwitch: false, taskIntent: false, toolSelection: false, skillSelection: false }
  });
  input.abortSignal?.throwIfAborted();
  const modelOnlyPlan: TurnPlannerResult = { ...planner, replyDecision: "reply", topicDecision: "continue_topic", toolsetIds: [], skillIds: [], requiredCapabilities: [], contextDependencies: [], recentDomainReuse: [], followupMode: "none" };
  delete modelOnlyPlan.taskIntent;
  recordGenerationPlannerDecision(deps, { sessionId: input.sessionId, planner: modelOnlyPlan, action: "continue", plannerReasons: ["modelSelection"] });
  const large = getModelRefsForRole(deps.config, "main_large");
  const selectLarge = planner.modelTier === "large" || planner.modelSelectionStatus === "undetermined";
  return { resolvedModelRef: selectLarge ? large : small, plannerDecision: modelOnlyPlan };
}
