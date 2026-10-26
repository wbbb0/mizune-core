import { prepareGenerationRequestBudget } from "./generationRequestBudget.ts";
import { characterRepository } from "../../character/repository.ts";
import { resolveSkillTaskId } from "../../skills/skillTaskIdentity.ts";
import { skillObservation, projectSkillObservations } from "../../skills/skillObservation.ts";
import { beginSkillTask, readPreviousSkillTaskId } from '../../skills/skillRuntime.ts';
import { readSkillDraft } from '../../skills/skillDrafts.ts';
import { SKILL_TOOL_NAMES, projectSkillForModel } from '../../llm/tools/runtime/skillTools.ts';
import type { TurnPlannerResult } from '../../conversation/turnPlanner.ts';
import { publishConversation } from "#conversation/crossConversationContext.ts";
import { createBuiltinToolExecutor, getBuiltinTools } from "#llm/builtinTools.ts";
import type { LlmMessage, LlmProviderCallUsage, LlmToolCall, LlmToolExecutionResult } from "#llm/llmClient.ts";
import { createEmptyUsage, mergeUsage, type LlmUsage } from "#llm/provider/providerTypes.ts";
import { getRoutingPresetTokenLimits } from "#llm/shared/modelRouting.ts";
import { extractToolError, parseToolArguments } from "#llm/shared/toolArgs.ts";
import type { Relationship } from "#identity/relationship.ts";
import {
  createUserTranscriptMessageItem,
  projectTranscriptMessageItemToHistoryMessage
} from "#conversation/session/historyContext.ts";
import { buildToolObservation, type ToolObservation } from "#conversation/session/toolObservation.ts";
import {
  createContextExtractionEvent,
  createGenerationFailureFallbackEvent,
  createInternalTriggerEvent,
  createModelFallbackEvent,
  createModelSelfUpgradeRouteEvent,
  formatErrorDetails
} from "#conversation/session/internalTranscriptEvents.ts";
import { buildBuiltinToolContext, type PromptDebugSnapshot } from "#llm/tools/core/shared.ts";
import type { PromptInteractionMode } from "#llm/prompt/promptTypes.ts";
import type { MessageContentPart } from "#messages/contentParts.ts";
import { createGenerationOutbound } from "./generationOutbound.ts";
import { createGenerationSegmentCoordinator } from "./generationSegmentCoordinator.ts";
import { createGenerationTypingWindow } from "./generationTypingWindow.ts";
import type { GenerationPromptParticipantProfile } from "./generationPromptBuilder.ts";
import type {
  GenerationCurrentUser,
  GenerationExecutorDeps,
  GenerationPersona
} from "./generationRunnerDeps.ts";
import type { InlineSessionTriggerExecution, InternalSessionTriggerExecution, InternalTranscriptItem, SessionDebugMarker } from "#conversation/session/sessionTypes.ts";
import type { ChatAttachment } from "#services/workspace/types.ts";
import {
  buildGenerationFailureAssistantMessage
} from "./generationExecutorSupport.ts";
import type {
  GenerationCommittedTextSink,
  GenerationDraftOverlaySink
} from "./generationOutputContracts.ts";
import {
  resolveToolNamesFromToolsets,
  TURN_PLANNER_ALWAYS_TOOL_NAMES
} from "#llm/tools/toolsets.ts";
import { TOOLSET_DEFINITIONS } from "../../llm/tools/toolsetCatalog.ts";
import { getBuiltinToolDescriptorByName } from "#llm/tools/toolRegistry.ts";
import { analyzeBuiltinToolConcurrency } from "#llm/tools/toolConcurrency.ts";
import type { ToolsetView } from "#llm/tools/toolsetCatalog.ts";
import { listSessionModes, requireSessionModeDefinition } from "#modes/registry.ts";
import type { SetupCompletionSignal } from "#modes/types.ts";
import { checkSetupCompletion } from "./generationSetupContext.ts";
import { waitForGenerationAbortGraceWindow } from "#app/runtime/runtimeTimingPolicy.ts";
import { maybeAutoCaptionSessionTitle, shouldAutoCaptionSessionTitle } from "./sessionCaptioner.ts";
import { createProviderOutputTokenStats } from "#conversation/session/transcriptTokenStats.ts";
import type { OneBotMessageFileSummary, OneBotSpecialSegmentSummary } from "#services/onebot/types.ts";
import { renderInlineTriggerBatchMessage } from "#llm/prompt/promptBuilder.ts";
import { sessionTaskTrackerService } from "#conversation/taskTracker/sessionTaskTrackerService.ts";
import type { SessionTaskTracker } from "#conversation/taskTracker/taskTrackerTypes.ts";
import {
  composeToolLoopCheckpointMessage,
  generateToolLoopCheckpointReport
} from "./toolLoopCheckpointReporter.ts";
import { collectToolLoopCheckpointResourceLines } from "./toolLoopCheckpointResources.ts";
import type { ToolLoopCheckpointObservation } from "#llm/prompts/tool-loop-checkpoint.prompt.ts";
import {
  classifyToolResultOutcome,
  parseToolResultObject
} from "#conversation/taskTracker/toolResultOutcome.ts";
import {
  MODEL_SELF_UPGRADE_TOOL_NAME,
  type ModelSelfUpgradePlan
} from "#llm/shared/modelSelfUpgrade.ts";
import { buildOutfitSignature } from "#modes/statefulRp/postTurnMaintainer.ts";

export interface GenerationRuntimeBatchMessage {
  chatType: "private" | "group";
  userId: string;
  senderName: string;
  text: string;
  contentParts?: MessageContentPart[];
  images: string[];
  audioSources: string[];
  audioIds: string[];
  emojiSources: string[];
  imageIds: string[];
  emojiIds: string[];
  attachments?: ChatAttachment[];
  messageFiles?: OneBotMessageFileSummary[];
  specialSegments?: OneBotSpecialSegmentSummary[];
  forwardIds: string[];
  replyMessageId: string | null;
  mentionUserIds: string[];
  mentionedAll: boolean;
  isAtMentioned: boolean;
  groupId?: string | undefined;
  receivedAt: number;
}

export interface GenerationSendTarget {
  delivery: "onebot" | "web";
  chatType: "private" | "group";
  userId: string;
  groupId?: string;
  senderName: string;
}

export interface RunGenerationInput {
  sessionId: string;
  expectedEpoch: number;
  responseAbortController: AbortController;
  responseEpoch: number;
  abortController: AbortController;
  modeId: string;
  relationship: Relationship;
  interactionMode: PromptInteractionMode;
  internalTranscript: InternalTranscriptItem[];
  debugMarkers: SessionDebugMarker[];
  toolRelationship?: Relationship | undefined;
  activeInternalTrigger?: InternalSessionTriggerExecution | null;
  currentUser: GenerationCurrentUser;
  persona: GenerationPersona;
  batchMessages: GenerationRuntimeBatchMessage[];
  sendTarget: GenerationSendTarget;
  participantProfiles: GenerationPromptParticipantProfile[];
  promptMessages: LlmMessage[];
  resolvedModelRef: string[];
  modelSelfUpgradePlan?: ModelSelfUpgradePlan | undefined;
  debugSnapshot: PromptDebugSnapshot;
  availableToolNames?: string[] | undefined;
  plannedToolsetIds?: string[] | undefined;
  skillPlannerDecision?: TurnPlannerResult | undefined;
  availableToolsets?: ToolsetView[] | undefined;
  setupMode?: boolean | undefined;
  setupCompletionSignal?: SetupCompletionSignal | undefined;
  setupOnComplete?: "exit_profile_operation" | "none" | undefined;
  streamResponse?: boolean | undefined;
  forceRegenerateTitleAfterTurn?: boolean | undefined;
  committedTextSink?: GenerationCommittedTextSink | undefined;
  draftOverlaySink?: GenerationDraftOverlaySink | undefined;
}

export async function projectProviderPreflightMessages(input: {
  messages: LlmMessage[];
  project: (messages: LlmMessage[]) => Promise<LlmMessage[]>;
}): Promise<LlmMessage[]> {
  if (input.messages[0]?.role !== "system") {
    return input.project(input.messages);
  }
  const stablePrefix = input.messages[0];
  const projectedSuffix = await input.project(input.messages.slice(1));
  return [stablePrefix, ...projectedSuffix];
}

// Executes a fully prepared generation request, including tools, streaming, and cleanup.
export function createGenerationExecutor(
  deps: GenerationExecutorDeps,
  handlers: {
    processNextSessionWork: (sessionId: string) => void;
  },
  options?: {
    waitForAbortGraceWindow?: (signal: AbortSignal) => Promise<void>;
  }
) {
  const {
    promptBuilder,
    sessionRuntime,
    identity,
    toolRuntime,
    lifecycle
  } = deps;
  const { config, mediaVisionService, mediaCaptionService } = promptBuilder;
  const { logger, llmClient, historyCompressor, messageQueue, sessionManager, sessionCaptioner } = sessionRuntime;
  const {
    oneBotClient,
    audioStore,
    requestStore,
    scheduledJobStore,
    shellRuntime,
    searchService,
    browserService,
    localFileService,
    temporaryWorkspaceService,
    chatFileStore,
    downloadRuntime,
    mediaInspectionService,
    textInspectionService,
    structuredSuggestionService,
    comfyClient,
    comfyTaskStore,
    comfyTemplateCatalog,
    forwardResolver
  } = toolRuntime;
  const {
    userStore,
    whitelistStore,
    personaStore,
    globalRuleStore,
    toolsetRuleStore,
    scenarioHostStateStore,
    statefulRpStateStore,
    statefulRpPostTurnMaintainer,
    setupStore,
    globalProfileReadinessStore,
    conversationAccess,
    npcDirectory
  } = identity;
  const { persistSession, getScheduler } = lifecycle;

  const runGeneration = async (input: RunGenerationInput): Promise<void> => {
    const {
      sessionId,
      expectedEpoch,
      responseAbortController,
      responseEpoch,
      abortController,
      relationship,
      interactionMode,
      internalTranscript,
      debugMarkers,
      toolRelationship,
      activeInternalTrigger,
      currentUser,
      batchMessages,
      sendTarget,
      promptMessages,
      resolvedModelRef,
      modelSelfUpgradePlan,
      debugSnapshot,
      availableToolNames,
      plannedToolsetIds,
      availableToolsets,
      setupMode,
      streamResponse,
      forceRegenerateTitleAfterTurn,
      committedTextSink,
      draftOverlaySink
    } = input;
    let outboundDrainPromise: Promise<void> | null = null;
    let completedSuccessfully = false;
    let generationFailed = false;
    let lastResultReasoningContent = "";
    let lastResultAssistantMetadata: Record<string, unknown> | undefined;
    let finalProviderCallUsage: LlmProviderCallUsage | null = null;
    let lastProviderRequestUsage: LlmUsage | null = null;
    const consumedSteerTexts: string[] = [];
    let historyCompressedForRequest = false;
    let statefulRpTurnBaseline: StatefulRpTurnBaseline | null = null;
    const checkpointObservations: ToolLoopCheckpointObservation[] = [];
    const runningProviderUsage = createEmptyUsage(resolvedModelRef[0] ?? null, null);
    const recordProviderCallUsage = (event: LlmProviderCallUsage): void => {
      lastProviderRequestUsage = { ...event.usage };
      mergeUsage(runningProviderUsage, event.usage);
      const usageApplied = sessionManager.setLastLlmUsageIfEpochMatches(sessionId, expectedEpoch, {
        ...runningProviderUsage,
        capturedAt: Date.now(),
        lastRequestUsage: lastProviderRequestUsage
      });
      if (usageApplied) {
        persistSession(sessionId, "llm_usage_updated");
      } else {
        logger.info({ sessionId, expectedEpoch, phase: event.phase }, "llm_usage_update_skipped_epoch_mismatch");
      }
    };
    const updateTaskTracker = (
      updater: (current: SessionTaskTracker) => SessionTaskTracker,
      persistReason: string
    ): void => {
      const current = sessionManager.getTaskTracker(sessionId);
      const next = updater(current);
      if (JSON.stringify(next) === JSON.stringify(current)) {
        return;
      }
      sessionManager.setTaskTracker(sessionId, next);
      persistSession(sessionId, persistReason);
    };
    const recordModelFallback = async (event: {
      summary: string;
      details: string;
      fromModelRef: string;
      toModelRef: string;
      fromProvider: string;
      toProvider: string;
    }): Promise<void> => {
      const applied = sessionManager.appendInternalTranscriptIfEpochMatches(sessionId, expectedEpoch, createModelFallbackEvent({
        timestampMs: Date.now(),
        summary: event.summary,
        details: event.details,
        fromModelRef: event.fromModelRef,
        toModelRef: event.toModelRef,
        fromProvider: event.fromProvider,
        toProvider: event.toProvider
      }));
      if (applied) {
        persistSession(sessionId, "internal_transcript_updated");
      }
    };
    const consumeInlineTriggers = async (): Promise<LlmMessage[]> => {
      const triggers = sessionManager.drainInlineTriggers(sessionId);
      if (triggers.length === 0) {
        return [];
      }
      for (const trigger of triggers) {
        sessionManager.appendInternalTranscript(sessionId, createInternalTriggerEvent({
          trigger,
          stage: "inlined"
        }));
      }
      persistSession(sessionId, "inline_trigger_inlined");
      const content = renderInlineTriggerBatchMessage(triggers);
      return [{ role: "user" as const, content }];
    };
    const typingWindow = createGenerationTypingWindow(
      {
        oneBotClient,
        sessionManager
      },
      {
        sessionId,
        responseEpoch,
        target: sendTarget
      }
    );

    persistSession(sessionId, "generation_started");
    logger.info({ sessionId, messageCount: batchMessages.length, streaming: streamResponse !== false }, "generation_started");

    try {
      await (options?.waitForAbortGraceWindow ?? waitForGenerationAbortGraceWindow)(abortController.signal);

      if (abortController.signal.aborted) {
        return;
      }
      let summary = "";
      const disableStreamingSplit = config.conversation.outbound.disableStreamingSplit === true;
      const outbound = createGenerationOutbound(
        {
          logger,
          messageQueue,
          oneBotClient,
          sessionManager,
          persistSession
        },
          {
            sessionId,
            responseEpoch,
            abortController,
            responseAbortController,
            sendTarget,
            ...(committedTextSink ? { committedTextSink } : {})
          }
        );
      const segmentCoordinator = createGenerationSegmentCoordinator({
        disableStreamingSplit,
        committedSink: outbound,
        isOutputSuppressed: () => sessionManager.getOutboundAbortSignal(sessionId)?.aborted === true,
        ...(draftOverlaySink ? {
          draftOverlaySink,
          draftStateSink: {
            replaceDraftText(text: string) {
              sessionManager.setActiveAssistantDraftResponseIfResponseEpochMatches(
                sessionId,
                responseEpoch,
                {
                  chatType: sendTarget.chatType,
                  userId: sendTarget.userId,
                  senderName: sendTarget.senderName
                },
                text,
                Date.now()
              );
            },
            clearDraftText() {
              sessionManager.setActiveAssistantDraftResponseIfResponseEpochMatches(
                sessionId,
                responseEpoch,
                {
                  chatType: sendTarget.chatType,
                  userId: sendTarget.userId,
                  senderName: sendTarget.senderName
                },
                "",
                Date.now()
              );
            }
          }
        } : {})
      });
      // 在模型请求边界消费新消息，保留上一轮工具结果与当前回复生命周期。
      const consumeSteerMessages = async (): Promise<LlmMessage[]> => {
        const steerMessages = sessionManager.consumeSteerMessages(sessionId);
        if (steerMessages.length === 0) {
          return [];
        }
        for (const message of steerMessages) {
          if (message.text.trim()) {
            consumedSteerTexts.push(message.text);
          }
        }
        await segmentCoordinator.discardPendingOutput();
        return steerMessages.map((message) => ({
          role: "user" as const,
          content: projectTranscriptMessageItemToHistoryMessage(createUserTranscriptMessageItem({
            chatType: message.chatType,
            userId: message.userId,
            senderName: message.senderName,
            text: message.text,
            ...(message.contentParts && message.contentParts.length > 0 ? { contentParts: message.contentParts } : {}),
            ...(message.imageIds.length > 0 ? { imageIds: message.imageIds } : {}),
            ...(message.emojiIds.length > 0 ? { emojiIds: message.emojiIds } : {}),
            ...(message.attachments && message.attachments.length > 0 ? { attachments: message.attachments } : {}),
            ...(message.audioSources.length > 0 ? { audioCount: message.audioSources.length } : {}),
            ...(message.forwardIds.length > 0 ? { forwardIds: message.forwardIds } : {}),
            ...(message.replyMessageId ? { replyMessageId: message.replyMessageId } : {}),
            ...(message.mentionUserIds.length > 0 ? { mentionUserIds: message.mentionUserIds } : {}),
            ...(message.mentionedAll ? { mentionedAll: true } : {}),
            ...(message.isAtMentioned ? { mentionedSelf: true } : {}),
            timestampMs: message.receivedAt
          })).content
        }));
      };
      const characterDraftId = setupMode ? characterRepository(config.dataDir).draft(sessionId)?.id ?? null : null;
      const hasToolsetBoundary = Array.isArray(availableToolsets);
      const isPlannerToolsetMode = hasToolsetBoundary && (setupMode || config.llm.turnPlanner.toolSelection === "planned");
      const activeToolsetIds = new Set((plannedToolsetIds ?? []).filter((id) => (
        availableToolsets?.some((item) => item.id === id) ?? false
      )));
      if (setupMode) for (const toolset of availableToolsets ?? []) {
        activeToolsetIds.add(toolset.id);
      }
      const taskSession = sessionManager.getSession(sessionId);
      const isSkillRuntimeActiveForTurn = (): boolean => (
        input.modeId !== "stateful_rp" || sessionManager.getOperationMode(sessionId).kind === "skill_config"
      );
      const previousSkillTaskId = config.skills.enabled ? readPreviousSkillTaskId(config, sessionId) : null;
      const planner = input.skillPlannerDecision;
      const activeTask = taskSession.taskTracker.primary;
      const explicitContinuation = batchMessages.length === 0 && activeInternalTrigger?.kind !== "scheduled_instruction";
      const skillTaskId = resolveSkillTaskId({
        sessionId, primary: activeTask, previousTaskId: previousSkillTaskId, planner,
        explicitContinuation, startedAt: batchMessages[0]?.receivedAt ?? Date.now()
      });
      const skills = beginSkillTask(config, sessionId, skillTaskId, taskSession.taskTracker.parked.map(task => task.taskId));
      if (isSkillRuntimeActiveForTurn() && config.skills.enabled && config.skills.plannerSelectionEnabled && planner) {
        for (const id of planner.skillIds ?? []) skills.load(id, "规划器选择");
        // 只有规划器真正选择的工具集是需求信号；all/默认全集永远不参与。
        if (config.llm.turnPlanner.toolSelection === "planned") skills.loadBound(planner.toolsetIds, "规划器明确工具需求");
      }
      let providerSeenSkillIds = new Set<string>();
      let toolsetUpgradeUsed = false;
      let modelUpgradeUsed = false;
      let activeGenerationModelRefs = [...resolvedModelRef];

      const isModelSelfUpgradeAvailable = (): boolean => modelSelfUpgradePlan != null && !modelUpgradeUsed;

      const resolveDynamicAllowedToolNames = (): string[] | undefined => {
        if (hasToolsetBoundary && availableToolsets!.length === 0) return [];
        if (!hasToolsetBoundary && availableToolNames?.length === 0) return [];
        const skillToolNames = isSkillRuntimeActiveForTurn() ? SKILL_TOOL_NAMES : [];
        const baseToolNames = hasToolsetBoundary
          ? [
              ...resolveToolNamesFromToolsets(availableToolsets!, isPlannerToolsetMode
                ? Array.from(activeToolsetIds)
                : availableToolsets!.map((item) => item.id)),
              ...TURN_PLANNER_ALWAYS_TOOL_NAMES,
              ...skillToolNames
            ]
          : availableToolNames;
        if (baseToolNames === undefined) {
          return undefined;
        }
        return Array.from(new Set([
          ...(setupMode ? skillToolNames : []),
          ...baseToolNames.filter((name) => name !== MODEL_SELF_UPGRADE_TOOL_NAME),
          ...(isModelSelfUpgradeAvailable() ? [MODEL_SELF_UPGRADE_TOOL_NAME] : [])
        ]));
      };

      const buildToolSelectionOptions = (options?: { forExecution?: boolean }) => {
        const forExecution = options?.forExecution === true;
        const visibleAllowedToolNames = resolveDynamicAllowedToolNames();
        const dynamicAllowedToolNames = forExecution && modelSelfUpgradePlan && visibleAllowedToolNames !== undefined
            ? Array.from(new Set([...visibleAllowedToolNames, MODEL_SELF_UPGRADE_TOOL_NAME]))
            : visibleAllowedToolNames;
        return {
          expectedCharacterDraftId: characterDraftId,
          operationMode: sessionManager.getOperationMode(sessionId),
          modelRef: resolvedModelRef,
          includeDebugTools: interactionMode === "debug",
          visibilityContext: {
            sessionId,
            replyDelivery: sendTarget.delivery,
            modelSelfUpgradeAvailable: forExecution
              ? modelSelfUpgradePlan != null
              : isModelSelfUpgradeAvailable()
          },
          ...(dynamicAllowedToolNames !== undefined
            ? { availableToolNames: dynamicAllowedToolNames }
            : {})
        };
      };
      const resolveCandidateTools = () => getBuiltinTools(
        toolRelationship ?? relationship,
        currentUser,
        config,
        buildToolSelectionOptions()
      );
      const resolveAllowedTools = resolveCandidateTools;

      const modelRoutingAccess = modelSelfUpgradePlan
        ? {
            requestModelUpgrade: (reason: string) => {
              if (modelUpgradeUsed) {
                return {
                  ok: true,
                  upgraded: false,
                  reason,
                  message: "本轮后续请求已经使用完整模型路由，请直接继续完成任务。"
                };
              }
              const applied = sessionManager.appendInternalTranscriptIfEpochMatches(
                sessionId,
                expectedEpoch,
                createModelSelfUpgradeRouteEvent({
                  reason,
                  fromModelRefs: modelSelfUpgradePlan.smallModelRefs,
                  toModelRefs: modelSelfUpgradePlan.largeModelRefs,
                  provider: modelSelfUpgradePlan.provider
                })
              );
              if (!applied) {
                return {
                  ok: false,
                  upgraded: false,
                  reason,
                  message: "当前生成状态已经变化，未切换模型路由。"
                };
              }
              modelUpgradeUsed = true;
              activeGenerationModelRefs = [...modelSelfUpgradePlan.largeModelRefs];
              persistSession(sessionId, "model_self_upgrade_requested");
              return {
                ok: true,
                upgraded: true,
                reason,
                message: "后续请求已切换到完整模型路由。请重新审视当前任务和已有工具结果，再完成回复；不要向用户提及内部模型路由。"
              };
            }
          }
        : undefined;

      const toolsetAccess = hasToolsetBoundary
        ? {
            listAvailableToolsets: () => ({
              available_toolsets: availableToolsets!.map((toolset) => ({
                id: toolset.id,
                title: toolset.title,
                description: toolset.description,
                tools: toolset.toolNames
              })),
              active_toolset_ids: Array.from(activeToolsetIds),
              request_limit_per_turn: setupMode ? null : 1,
              remaining_request_quota: setupMode ? null : toolsetUpgradeUsed ? 0 : 1
            }),
            requestToolsets: (toolsetIds: string[], reason: string) => {
              const requested = Array.from(new Set(toolsetIds.map((item) => item.trim()).filter(Boolean)));
              if (requested.length === 0) {
                return {
                  ok: false,
                  requested_toolset_ids: [],
                  approved_toolset_ids: [],
                  rejected_toolset_ids: [],
                  active_toolset_ids: Array.from(activeToolsetIds),
                  reason: reason || null,
                  message: "toolset_ids is empty"
                };
              }
              if (!setupMode && toolsetUpgradeUsed) {
                return {
                  ok: false,
                  requested_toolset_ids: requested,
                  approved_toolset_ids: [],
                  rejected_toolset_ids: requested,
                  active_toolset_ids: Array.from(activeToolsetIds),
                  reason: reason || null,
                  message: "toolset request quota exceeded for this turn"
                };
              }
              const allowedIds = new Set(availableToolsets!.map((item) => item.id));
              const approved = requested.filter((id) => allowedIds.has(id));
              const rejected = requested.filter((id) => !allowedIds.has(id));
              if (isSkillRuntimeActiveForTurn()) {
                skills.loadBound(approved, "模型显式申请工具集");
              }
              for (const id of approved) {
                activeToolsetIds.add(id);
              }
              toolsetUpgradeUsed = true;
              return {
                ok: approved.length > 0,
                requested_toolset_ids: requested,
                approved_toolset_ids: approved,
                rejected_toolset_ids: rejected,
                active_toolset_ids: Array.from(activeToolsetIds),
                reason: reason || null,
                message: approved.length > 0
                  ? "toolset request approved"
                  : "no requested toolset could be approved"
              };
            }
          }
        : undefined;

      const builtinToolContext = buildBuiltinToolContext({
        config,
        relationship: toolRelationship ?? relationship,
        replyDelivery: sendTarget.delivery,
        lastMessage: {
          sessionId,
          userId: sendTarget.userId,
          senderName: sendTarget.senderName
        },
        currentUser,
        oneBotClient,
        audioStore,
        chatFileStore,
        downloadRuntime,
        mediaVisionService,
        mediaCaptionService,
        mediaInspectionService,
        ...(deps.toolRuntime.stickerService ? { stickerService: deps.toolRuntime.stickerService } : {}),
        textInspectionService,
        ...(deps.toolRuntime.documentSummaryService ? { documentSummaryService: deps.toolRuntime.documentSummaryService } : {}),
        ...(deps.toolRuntime.contextEmbeddingService ? { contextEmbeddingService: deps.toolRuntime.contextEmbeddingService } : {}),
        requestStore,
        sessionManager,
        whitelistStore,
        scheduledJobStore,
        scheduler: getScheduler(),
        messageQueue,
        shellRuntime,
        searchService,
        browserService,
        localFileService,
        temporaryWorkspaceService,
        comfyClient,
        comfyTaskStore,
        comfyTemplateCatalog,
        forwardResolver,
        userStore,
        contextStore: deps.identity.contextStore,
        personaStore,
        globalRuleStore,
        toolsetRuleStore,
        scenarioHostStateStore,
        ...(statefulRpStateStore ? { statefulRpStateStore } : {}),
        ...(structuredSuggestionService ? { structuredSuggestionService } : {}),
        setupStore,
        globalProfileReadinessStore,
        conversationAccess,
        npcDirectory,
        userIdentityStore: lifecycle.userIdentityStore,
        skillAccess: skills,
        ...(toolsetAccess ? { toolsetAccess } : {}),
        ...(modelRoutingAccess ? { modelRoutingAccess } : {}),
        debugSnapshot,
        persistSession,
        listSessionModes,
        abortSignal: abortController.signal,
        ...(committedTextSink ? { committedTextSink } : {}),
        ...(activeInternalTrigger !== undefined ? { activeInternalTrigger } : {})
      });

      const assertGenerationCurrent = (): void => {
        if (abortController.signal.aborted || responseAbortController.signal.aborted) {
          throw new Error("当前生成已被取消。");
        }
        if (sessionManager.getMutationEpoch(sessionId) === expectedEpoch) {
          return;
        }
        abortController.abort();
        responseAbortController.abort();
        throw new Error("当前生成已被更新的会话 epoch 取代。");
      };

      const toolExecutor = async (toolCall: LlmToolCall): Promise<string | LlmToolExecutionResult> => {
        assertGenerationCurrent();
        const args = parseToolArguments(toolCall.function.arguments || "{}", logger, {
          toolName: toolCall.function.name,
          toolCallId: toolCall.id
        });
        let toolResult: string | LlmToolExecutionResult;
        try {
          if (isSkillRuntimeActiveForTurn() && resolveAllowedTools().some(tool => tool.function.name === toolCall.function.name) && !SKILL_TOOL_NAMES.includes(toolCall.function.name) && toolCall.function.name !== "request_toolset") {
            const requiredToolsets = (availableToolsets ?? TOOLSET_DEFINITIONS).filter(toolset => toolset.toolNames.includes(toolCall.function.name));
            const loaded = skills.loadBound(requiredToolsets.map(toolset => toolset.id), `实际工具需求：${toolCall.function.name}`);
            if (loaded.some(skill => !providerSeenSkillIds.has(`${skill.id}:${skill.revision}`))) {
              return skillObservation("deferred", loaded, { deferred: true, executed: false, message: "已加载相关技能。请先阅读下面方法，重新计划后再次调用；本次工具尚未执行。", skills: loaded.map(projectSkillForModel) });
            }
          }
          const rawToolExecutor = createBuiltinToolExecutor(
            builtinToolContext,
            buildToolSelectionOptions({ forExecution: true })
          );
          toolResult = await rawToolExecutor(toolCall, args);
        } catch (error: unknown) {
          assertGenerationCurrent();
          const message = error instanceof Error ? error.message : String(error);
          logger.warn(
            {
              toolName: toolCall.function.name,
              toolCallId: toolCall.id,
              message
            },
            "tool_call_wrapped_error_returned"
          );
          return JSON.stringify({
            error: message
          });
        }
        assertGenerationCurrent();
        return toolResult;
      };

      if (llmClient.isConfigured(resolvedModelRef)) {
        try {
          statefulRpTurnBaseline = await captureStatefulRpTurnBaseline({
            modeId: input.modeId,
            setupMode,
            sessionId,
            statefulRpStateStore
          });
          const activeToolCounts = new Map<string, number>();
          const listActiveToolNames = () => [...activeToolCounts.entries()]
            .filter(([, count]) => count > 0)
            .map(([name]) => name);
          sessionManager.setSessionPhaseIfEpochMatches(sessionId, expectedEpoch, { kind: "requesting_llm" });
          const result = await llmClient.generate({
            messages: promptMessages,
            modelRefOverride: resolvedModelRef,
            ...(modelSelfUpgradePlan ? {
              resolveModelRefOverride: () => activeGenerationModelRefs
            } : {}),
            enableThinkingOverride: config.llm.mainRouting.enableThinking,
            tools: resolveAllowedTools,
            abortSignal: abortController.signal,
            consumeSteerMessages,
            consumeInlineTriggers,
            projectMessagesBeforeProvider: async (messages) => {
              assertGenerationCurrent();
              const skillDraft = sessionManager.getOperationMode(sessionId).kind === "skill_config" ? readSkillDraft(config, sessionId) : null;
              const skillInstructions = isSkillRuntimeActiveForTurn()
                ? [skills.catalog(), skills.documents(), ...(skillDraft ? [
                    `当前在技能 ${skillDraft.id} 的临时草稿编辑流程。用 get_skill 查看、save_skill 更新完整草稿和绑定；明确展示草稿，等待用户 .confirm 发布或 .cancel 放弃。当前草稿：${JSON.stringify(skillDraft)}`
                  ] : [])].filter(Boolean).join("\n\n")
                : "";
              const cleanMessages = projectSkillObservations(config, messages).filter(message => !(message.role === "system" && typeof message.content === "string" && message.content.startsWith("[实例技能上下文]")));
              const currentMessages: LlmMessage[] = skillInstructions
                ? [...cleanMessages.slice(0, 1), { role: "system", content: `[实例技能上下文]\n${skillInstructions}` }, ...cleanMessages.slice(1)]
                : cleanMessages;
              providerSeenSkillIds = new Set(skills.view().loaded.map(skill => `${skill.id}:${skill.revision}`));
              const projectedMessages = await projectProviderPreflightMessages({
                messages: currentMessages,
                project: async (projectableMessages) => (
                  (await promptBuilder.contentSafetyService?.projectLlmMessages({
                    sessionId,
                    source: "provider_call_preflight",
                    messages: projectableMessages,
                    abortSignal: abortController.signal
                  }))?.messages ?? projectableMessages
                )
              });
              assertGenerationCurrent();
              return projectedMessages;
            },
            prepareRequestForBudget: async (request) => {
              assertGenerationCurrent();
              const messages = await prepareGenerationRequestBudget({
                ...request, config, sessionId, logger,
                transcript: sessionManager.getSession(sessionId).internalTranscript,
                compact: async () => {
                  sessionManager.setSessionPhaseIfEpochMatches(sessionId, expectedEpoch, { kind: "compressing_history" });
                  try {
                    const result = await historyCompressor.compactForRequest(sessionId,
                      Math.min(getRoutingPresetTokenLimits(config).retainTokens, Math.floor(request.budget.inputTokens / 2)), abortController.signal);
                    assertGenerationCurrent();
                    if (result) {
                      historyCompressedForRequest = true;
                      persistSession(sessionId, "request_budget_history_compressed");
                    }
                    return result;
                  } finally {
                    sessionManager.setSessionPhaseIfEpochMatches(sessionId, expectedEpoch, { kind: "requesting_llm" });
                  }
                }
              });
              assertGenerationCurrent();
              return messages;
            },
            onProviderCallUsage: async (event) => {
              recordProviderCallUsage(event);
            },
            toolConcurrency: {
              analyze: analyzeBuiltinToolConcurrency,
              maxConcurrency: 4
            },
            onProviderResponseComplete: async (event) => {
              if (event.phase === "tool_call") {
                await segmentCoordinator.flushBufferedChunk();
              }
            },
            resolveAssistantToolCallContent: (event) => segmentCoordinator.resolveProviderAssistantText(event.text),
            toolExecutor: async (toolCall) => {
              activeToolCounts.set(toolCall.function.name, (activeToolCounts.get(toolCall.function.name) ?? 0) + 1);
              sessionManager.setSessionPhaseIfEpochMatches(sessionId, expectedEpoch, {
                kind: "tool_calling",
                toolNames: listActiveToolNames(),
                lastToolName: toolCall.function.name
              });
              try {
                return await toolExecutor(toolCall);
              } finally {
                const nextCount = (activeToolCounts.get(toolCall.function.name) ?? 1) - 1;
                if (nextCount > 0) {
                  activeToolCounts.set(toolCall.function.name, nextCount);
                } else {
                  activeToolCounts.delete(toolCall.function.name);
                }
                const remainingToolNames = listActiveToolNames();
                if (remainingToolNames.length > 0) {
                  sessionManager.setSessionPhaseIfEpochMatches(sessionId, expectedEpoch, {
                    kind: "tool_calling",
                    toolNames: remainingToolNames,
                    lastToolName: remainingToolNames[remainingToolNames.length - 1] ?? toolCall.function.name
                  });
                } else {
                  sessionManager.setSessionPhaseIfEpochMatches(sessionId, expectedEpoch, { kind: "requesting_llm" });
                }
              }
            },
            onAssistantToolCalls: async (message, usageEvent) => {
              const tokenStats = usageEvent
                ? createProviderOutputTokenStats({
                    outputTokens: usageEvent.usage.outputTokens,
                    reasoningTokens: usageEvent.usage.reasoningTokens,
                    modelRef: usageEvent.usage.modelRef,
                    model: usageEvent.usage.model,
                    providerReported: usageEvent.usage.providerReported,
                    capturedAt: Date.now()
                  }, message.reasoning_content, config)
                : undefined;
              const applied = sessionManager.appendInternalTranscriptIfEpochMatches(sessionId, expectedEpoch, {
                kind: "assistant_tool_call",
                llmVisible: true,
                timestampMs: Date.now(),
                content: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
                toolCalls: message.tool_calls ?? [],
                ...(typeof message.reasoning_content === "string" ? { reasoningContent: message.reasoning_content } : {}),
                ...(message.providerMetadata ? { providerMetadata: message.providerMetadata } : {}),
                ...(tokenStats ? { tokenStats } : {})
              });
              if (applied) {
                persistSession(sessionId, "internal_transcript_updated");
              }
            },
            onToolResultMessage: async (message, toolCall, resultMetadata) => {
              const content = typeof message.content === "string"
                ? message.content
                : JSON.stringify(message.content);
              const observationContent = resultMetadata?.canonicalContent ?? content;
              // Some tests and legacy custom generators still pass the tool name string here.
              const toolName = typeof toolCall === "string" ? toolCall : toolCall.function.name;
              const toolArguments = typeof toolCall === "string" ? "{}" : toolCall.function.arguments;
              const toolCallId = typeof toolCall === "string" ? (message.tool_call_id ?? "") : toolCall.id;
              const toolArgs = parseToolArguments(toolArguments || "{}", logger, {
                toolName,
                toolCallId
              });
              const toolDescriptor = getBuiltinToolDescriptorByName(toolName, config);
              const observedAtMs = Date.now();
              const observation = buildToolObservation({
                toolName,
                toolCallId,
                content: observationContent,
                args: typeof toolArgs === "object" && toolArgs !== null && !Array.isArray(toolArgs)
                  ? toolArgs as Record<string, unknown>
                  : {},
                ...(toolDescriptor?.resultObservation ? { policy: toolDescriptor.resultObservation } : {})
              });
              const applied = sessionManager.appendInternalTranscriptIfEpochMatches(sessionId, expectedEpoch, {
                kind: "tool_result",
                llmVisible: true,
                timestampMs: observedAtMs,
                toolCallId,
                toolName,
                content,
                ...(resultMetadata?.canonicalContent !== undefined ? { canonicalContent: resultMetadata.canonicalContent } : {}),
                observation
              });
              if (applied) {
                checkpointObservations.push(buildCheckpointObservation({
                  toolName,
                  toolCallId,
                  content: observationContent,
                  observation,
                  timestampMs: observedAtMs
                }));
                updateTaskTracker((tracker) => sessionTaskTrackerService.observeToolResult({
                  sessionId,
                  tracker,
                  toolName,
                  toolCallId,
                  content,
                  ...(resultMetadata?.canonicalContent !== undefined ? { canonicalContent: resultMetadata.canonicalContent } : {}),
                  observation,
                  args: typeof toolArgs === "object" && toolArgs !== null && !Array.isArray(toolArgs)
                    ? toolArgs as Record<string, unknown>
                    : {},
                  originalRequest: renderBatchOriginalRequest(batchMessages),
                  nowMs: observedAtMs
                }), "task_tracker_tool_result_observed");
                persistSession(sessionId, "internal_transcript_updated");
              }
            },
            onFallbackEvent: recordModelFallback,
            ...(streamResponse === false
              ? {}
                : {
                  onPreviewTextDelta: async (delta: string) => {
                    assertGenerationCurrent();
                    sessionManager.setSessionPhaseIfEpochMatches(sessionId, expectedEpoch, { kind: "generating" });
                    await segmentCoordinator.onPreviewTextDelta(delta);
                  },
                  onPreviewReset: () => segmentCoordinator.resetPreview(),
                  onReasoningDelta: (_delta: string) => {
                    sessionManager.setSessionPhaseIfEpochMatches(sessionId, expectedEpoch, { kind: "reasoning" });
                    void typingWindow.startIfNeeded();
                  },
                  onTextDelta: async (delta: string) => {
                    sessionManager.setSessionPhaseIfEpochMatches(sessionId, expectedEpoch, { kind: "generating" });
                    await segmentCoordinator.onTextDelta(delta);
                  }
                })
          });
          let completedUsage = result.usage;
          if (result.finishReason?.kind === "tool_call_limit") {
            const checkpointCause = result.finishReason.cause === "protocol_recovery"
              ? "protocol_recovery"
              : "tool_iterations";
            assertGenerationCurrent();
            sessionManager.setSessionPhaseIfEpochMatches(sessionId, expectedEpoch, { kind: "requesting_llm" });
            const originalRequest = renderBatchOriginalRequest(batchMessages);
            const checkpointAtMs = Date.now();
            const checkpointTracker = sessionTaskTrackerService.observeToolLimitCheckpoint({
              sessionId,
              tracker: sessionManager.getTaskTracker(sessionId),
              originalRequest,
              nowMs: checkpointAtMs
            });
            const checkpointReport = await generateToolLoopCheckpointReport({
              config,
              llmClient,
              logger,
              sessionId,
              modeId: input.modeId,
              originalRequest,
              taskTracker: checkpointTracker,
              observations: checkpointObservations,
              persona: input.persona,
              sessionBotProfile: sessionManager.getSession(sessionId).botProfile,
              cause: checkpointCause,
              abortSignal: abortController.signal,
              assertCurrent: assertGenerationCurrent,
              onProviderCallUsage: recordProviderCallUsage,
              onFallbackEvent: recordModelFallback
            });
            assertGenerationCurrent();
            const liveResourceLines = await collectToolLoopCheckpointResourceLines({
              observations: checkpointObservations,
              shellRuntime,
              browserService,
              downloadRuntime,
              logger,
              sessionId,
              assertCurrent: assertGenerationCurrent
            });
            assertGenerationCurrent();
            const checkpointText = composeToolLoopCheckpointMessage({
              body: checkpointReport.body,
              liveResourceLines,
              cause: checkpointCause
            });
            const committed = await segmentCoordinator.appendStandalone(checkpointText);
            assertGenerationCurrent();
            if (committed === false && !sessionManager.getOutboundAbortSignal(sessionId)?.aborted) {
              throw new Error("任务检查点未能提交到当前回复。");
            }
            const nextTracker = sessionManager.updateTaskTrackerIfEpochMatches(
              sessionId,
              expectedEpoch,
              (current) => sessionTaskTrackerService.observeToolLimitCheckpoint({
                sessionId,
                tracker: current,
                originalRequest,
                nowMs: checkpointAtMs
              })
            );
            if (!nextTracker) {
              assertGenerationCurrent();
              throw new Error("任务检查点状态未能写入当前会话。");
            }
            persistSession(sessionId, "task_tracker_tool_limit_checkpoint");
            summary = "";
            lastResultReasoningContent = "";
            lastResultAssistantMetadata = undefined;
            finalProviderCallUsage = checkpointReport.modelGenerated
              ? checkpointReport.finalProviderCallUsage
              : null;
            completedUsage = mergeGenerationUsages(result.usage, checkpointReport.usage);
          } else {
            summary = result.text;
            lastResultReasoningContent = result.reasoningContent ?? "";
            lastResultAssistantMetadata = result.assistantMetadata;
            finalProviderCallUsage = [...(result.providerCallUsages ?? [])].reverse()
              .find((event) => event.phase === "final_response" || event.phase === "terminal_response")
              ?? null;
          }
          const usageApplied = sessionManager.setLastLlmUsageIfEpochMatches(sessionId, expectedEpoch, {
            ...completedUsage,
            capturedAt: Date.now(),
            lastRequestUsage: lastProviderRequestUsage
          });
          if (usageApplied) {
            persistSession(sessionId, "llm_usage_updated");
          } else {
            logger.info({ sessionId, expectedEpoch }, "llm_usage_update_skipped_epoch_mismatch");
          }
        } catch (error: unknown) {
          generationFailed = true;
          logger.error({ err: error, sessionId }, "generation_failed");
          if (abortController.signal.aborted || responseAbortController.signal.aborted) {
            throw error;
          }

          const failureMessage = buildGenerationFailureAssistantMessage();
          const fallbackEventApplied = sessionManager.appendInternalTranscriptIfEpochMatches(
            sessionId,
            expectedEpoch,
            createGenerationFailureFallbackEvent({
              timestampMs: Date.now(),
              details: formatErrorDetails(error),
              failureMessage
            })
          );
          if (fallbackEventApplied) {
            persistSession(sessionId, "internal_transcript_updated");
          }
          await segmentCoordinator.flushBufferedChunk();
          await outbound.enqueueChunk(failureMessage, {
            joinWithDoubleNewline: outbound.hasSentAssistantChunk()
          });
          await draftOverlaySink?.fail(failureMessage);
          summary = "";
        }
      } else {
        summary = "LLM 未配置。请在 LLM catalog 文件中填写 provider、model 与 routing preset 清单，在运行时配置中设置 llm.routingPreset，并将 llm.enabled 设为 true。";
      }

      await segmentCoordinator.flushSummary(summary, streamResponse);
      await draftOverlaySink?.complete();
      outboundDrainPromise = outbound.getDrainPromise();

      completedSuccessfully = !generationFailed;
      persistSession(sessionId, "generation_completed");
    } catch (error: unknown) {
      completedSuccessfully = false;
      logger.error({ err: error, sessionId }, "generation_failed");
      throw error;
    } finally {
      const finishedCurrent = sessionManager.finishGeneration(sessionId, abortController);
      if (finishedCurrent && setupMode && input.setupCompletionSignal && input.setupOnComplete) {
        const modeId = sessionManager.getModeId(sessionId);
        const modeDef = requireSessionModeDefinition(modeId);
        if (modeDef.setupPhase) {
          const isComplete = await checkSetupCompletion(
            input.setupCompletionSignal,
            sessionId,
            { setupStore, scenarioHostStateStore, sessionManager }
          );
          if (isComplete && input.setupOnComplete === "exit_profile_operation") {
            sessionManager.finishProfileOperation(sessionId, {
              action: "exit_confirmed",
              source: "automatic"
            });
            persistSession(sessionId, "setup_completed_profile_phase_exited");
          }
        }
      }

      if (!sessionManager.isResponseOpen(sessionId, responseEpoch)) {
        await typingWindow.stopIfStarted();
        await draftOverlaySink?.complete();
        if (finishedCurrent) {
          persistSession(sessionId, "generation_finished");
        }
        return;
      }

      try {
        await outboundDrainPromise;
      } catch (error: unknown) {
        completedSuccessfully = false;
        logger.warn({ err: error, sessionId }, "outbound_drain_failed");
      }

      await typingWindow.stopIfStarted();

      if (lastResultReasoningContent) {
        sessionManager.setLastAssistantReasoningIfResponseEpochMatches(
          sessionId,
          responseEpoch,
          lastResultReasoningContent
        );
      }
      if (lastResultAssistantMetadata) {
        sessionManager.setLastAssistantProviderMetadataIfResponseEpochMatches(
          sessionId,
          responseEpoch,
          lastResultAssistantMetadata
        );
      }

      if (finalProviderCallUsage) {
        const applied = sessionManager.applyActiveResponseTokenStatsIfResponseEpochMatches(sessionId, responseEpoch, {
          outputTokens: finalProviderCallUsage.usage.outputTokens,
          reasoningTokens: finalProviderCallUsage.usage.reasoningTokens,
          modelRef: finalProviderCallUsage.usage.modelRef,
          model: finalProviderCallUsage.usage.model,
          providerReported: finalProviderCallUsage.usage.providerReported,
          capturedAt: Date.now()
        });
        if (applied) {
          persistSession(sessionId, "assistant_response_token_stats_updated");
        }
      }

      const finalizedAssistant = sessionManager.finalizeActiveAssistantResponseIfResponseEpochMatches(
        sessionId,
        responseEpoch,
        Date.now()
      );
      if (finalizedAssistant && completedSuccessfully && !abortController.signal.aborted && !responseAbortController.signal.aborted && !sessionManager.getOutboundAbortSignal(sessionId)?.aborted) {
        publishConversation(sessionManager.getSession(sessionId), Date.now());
        persistSession(sessionId, "cross_conversation_reply_published");
      }
      if (finalizedAssistant) {
        logger.info(
          {
            sessionId,
            role: "assistant",
            contentLength: finalizedAssistant.text.length,
            contentPreview: finalizedAssistant.text.slice(0, 120)
          },
          "history_assistant_appended"
        );
        persistSession(sessionId, "assistant_response_finalized");
        updateTaskTracker((tracker) => sessionTaskTrackerService.observeAssistantFinalResponse({
          tracker,
          text: finalizedAssistant.text,
          nowMs: Date.now()
        }), "task_tracker_assistant_response_observed");
        const targetUserIds = collectExtractionUserIds(input.batchMessages);
        const scenarioHostMode = input.modeId === "scenario_host";
        if (!scenarioHostMode && input.currentUser?.userId && lifecycle.contextExtractionQueue) {
          try {
            for (const userId of targetUserIds) {
              lifecycle.contextExtractionQueue.enqueueTurn({
                sessionId,
                userId,
                chatType: sendTarget.chatType,
                senderName: input.batchMessages.find((message) => message.userId === userId)?.senderName ?? sendTarget.senderName,
                userMessages: input.batchMessages.map((message) => ({
                  userId: message.userId,
                  senderName: message.senderName,
                  text: message.text,
                  receivedAt: message.receivedAt
                })),
                assistantText: finalizedAssistant.text,
                completedAt: Date.now()
              });
            }
          } catch (error) {
            logger.warn({
              sessionId,
              error: error instanceof Error ? error.message : String(error)
            }, "context_extraction_enqueue_failed_open");
            appendContextExtractionTranscriptEvent({
              sessionManager,
              persistSession,
              sessionId,
              expectedEpoch,
              status: "enqueue_failed",
              targetUserIds,
              messageCount: input.batchMessages.length,
              error
            });
          }
        }
      }

      if (
        completedSuccessfully
        && finalizedAssistant?.text.trim()
        && !abortController.signal.aborted
        && !responseAbortController.signal.aborted
        && !sessionManager.getOutboundAbortSignal(sessionId)?.aborted
      ) {
        await runStatefulRpPostTurnIfApplicable({
          modeId: input.modeId,
          setupMode,
          sessionId,
          expectedEpoch,
          sessionManager,
          statefulRpPostTurnMaintainer,
          baseline: statefulRpTurnBaseline,
          batchMessages: input.batchMessages,
          consumedSteerTexts,
          assistantText: finalizedAssistant.text,
          personaName: input.persona.name,
          abortSignal: responseAbortController.signal,
          logger,
          persistSession
        });
      }

      if (finishedCurrent) {
        persistSession(sessionId, "generation_finished");
      }

      if (sessionManager.hasPendingSteerMessages(sessionId)) {
        const promoted = sessionManager.promoteSteerMessagesToPending(sessionId);
        if (promoted > 0) {
          persistSession(sessionId, "steer_messages_promoted_after_generation");
        }
      }

      if (sessionManager.completeResponse(sessionId, responseEpoch)) {
        const captionForceRegenerate = forceRegenerateTitleAfterTurn === true || historyCompressedForRequest;
        const sessionAfterCompletion = sessionManager.getSession(sessionId);
        if (shouldAutoCaptionSessionTitle(sessionAfterCompletion, { forceRegenerate: captionForceRegenerate })) {
          void maybeAutoCaptionSessionTitle({
            sessionId,
            sessionManager,
            sessionCaptioner,
            expectedHistoryRevision: sessionAfterCompletion.historyRevision,
            forceRegenerate: captionForceRegenerate,
            persistSession,
            logger,
            reason: captionForceRegenerate ? "generation_completed_title_regenerated" : "generation_completed_captioned"
          }).catch((error: unknown) => {
            logger.warn(
              { err: error, sessionId, forceRegenerate: captionForceRegenerate },
              "session_title_auto_caption_background_failed"
            );
          });
        }
        handlers.processNextSessionWork(sessionId);
      }
    }
  };

  return {
    runGeneration
  };
}

function collectExtractionUserIds(messages: GenerationRuntimeBatchMessage[]): string[] {
  const userIds: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (!message.text.trim() || seen.has(message.userId)) {
      continue;
    }
    seen.add(message.userId);
    userIds.push(message.userId);
  }
  return userIds;
}

function renderBatchOriginalRequest(messages: GenerationRuntimeBatchMessage[]): string {
  return messages
    .map((message) => message.text.trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 1200);
}

function buildCheckpointObservation(input: {
  toolName: string;
  toolCallId: string;
  content: string;
  observation: ToolObservation;
  timestampMs: number;
}): ToolLoopCheckpointObservation {
  const parsed = parseToolResultObject(input.content);
  const explicitError = extractToolError(input.content);
  const outcome = classifyToolResultOutcome(parsed);
  const resource = input.observation.resource ?? extractDownloadResource(parsed);
  return {
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    outcome,
    summary: explicitError
      ? `${input.observation.summary}；错误：${explicitError}`
      : input.observation.summary,
    timestampMs: input.timestampMs,
    contentHash: input.observation.contentHash,
    ...(resource ? { resource } : {})
  };
}

function extractDownloadResource(parsed: Record<string, unknown> | null): ToolObservation["resource"] | undefined {
  const rawId = parsed?.resource_id ?? parsed?.resourceId;
  const resourceId = typeof rawId === "string" ? rawId.trim() : "";
  return resourceId.startsWith("res_download_")
    ? { kind: "external", id: resourceId }
    : undefined;
}

function mergeGenerationUsages(primary: LlmUsage, secondary: LlmUsage | null): LlmUsage {
  const merged = createEmptyUsage(primary.modelRef, primary.model);
  mergeUsage(merged, primary);
  if (secondary) {
    mergeUsage(merged, secondary);
  }
  return merged;
}

function appendContextExtractionTranscriptEvent(input: {
  sessionManager: Pick<GenerationExecutorDeps["sessionRuntime"]["sessionManager"], "appendInternalTranscriptIfEpochMatches">;
  persistSession: GenerationExecutorDeps["lifecycle"]["persistSession"];
  sessionId: string;
  expectedEpoch: number;
  status: "queued" | "enqueue_failed";
  targetUserIds: string[];
  messageCount: number;
  error?: unknown;
}): void {
  if (input.targetUserIds.length === 0) {
    return;
  }
  const applied = input.sessionManager.appendInternalTranscriptIfEpochMatches(
    input.sessionId,
    input.expectedEpoch,
    createContextExtractionEvent({
      status: input.status,
      targetUserIds: input.targetUserIds,
      messageCount: input.messageCount,
      ...(input.error !== undefined ? { error: input.error } : {})
    })
  );
  if (applied) {
    input.persistSession(input.sessionId, "context_extraction_transcript_updated");
  }
}

interface StatefulRpTurnBaseline {
  clockBeforeTurnIso: string | null;
  outfitSignatureBeforeTurn: string | null;
}

async function captureStatefulRpTurnBaseline(input: {
  modeId?: string | undefined;
  setupMode?: boolean | undefined;
  sessionId: string;
  statefulRpStateStore?: GenerationExecutorDeps["identity"]["statefulRpStateStore"] | undefined;
}): Promise<StatefulRpTurnBaseline | null> {
  if (input.modeId !== "stateful_rp" || input.setupMode || !input.statefulRpStateStore) {
    return null;
  }
  const stateBefore = await input.statefulRpStateStore.get(input.sessionId);
  if (!stateBefore?.initialized) {
    return null;
  }
  return {
    clockBeforeTurnIso: stateBefore?.simulation.clock?.currentIso ?? null,
    outfitSignatureBeforeTurn: stateBefore ? buildOutfitSignature(stateBefore) : null
  };
}

async function runStatefulRpPostTurnIfApplicable(input: {
  modeId?: string | undefined;
  setupMode?: boolean | undefined;
  sessionId: string;
  expectedEpoch: number;
  sessionManager: Pick<GenerationExecutorDeps["sessionRuntime"]["sessionManager"], "getMutationEpoch">;
  statefulRpPostTurnMaintainer?: GenerationExecutorDeps["identity"]["statefulRpPostTurnMaintainer"] | undefined;
  baseline: StatefulRpTurnBaseline | null;
  batchMessages: GenerationRuntimeBatchMessage[];
  consumedSteerTexts: string[];
  assistantText: string;
  personaName: string;
  abortSignal: AbortSignal;
  logger: GenerationExecutorDeps["sessionRuntime"]["logger"];
  persistSession: GenerationExecutorDeps["lifecycle"]["persistSession"];
}): Promise<void> {
  if (input.modeId !== "stateful_rp" || input.setupMode || !input.statefulRpPostTurnMaintainer) {
    return;
  }
  if (input.abortSignal.aborted || input.sessionManager.getMutationEpoch(input.sessionId) !== input.expectedEpoch) {
    return;
  }
  const userText = [
    ...input.batchMessages.map((message) => message.text),
    ...input.consumedSteerTexts
  ]
    .map((text) => text.trim())
    .filter(Boolean)
    .join("\n");

  try {
    const nextRpState = await input.statefulRpPostTurnMaintainer.runPostTurn({
      sessionId: input.sessionId,
      clockBeforeTurnIso: input.baseline?.clockBeforeTurnIso ?? null,
      outfitSignatureBeforeTurn: input.baseline?.outfitSignatureBeforeTurn ?? null,
      userText,
      assistantText: input.assistantText,
      personaName: input.personaName,
      isCurrent: () => input.sessionManager.getMutationEpoch(input.sessionId) === input.expectedEpoch,
      abortSignal: input.abortSignal
    });
    if (input.abortSignal.aborted || input.sessionManager.getMutationEpoch(input.sessionId) !== input.expectedEpoch) {
      return;
    }
    if (nextRpState) {
      input.logger.info({ sessionId: input.sessionId, clockIso: nextRpState.simulation.clock?.currentIso }, "stateful_rp_post_turn_maintained");
      input.persistSession(input.sessionId, "stateful_rp_post_turn_maintained");
    }
  } catch (error: unknown) {
    input.logger.warn({ err: error, sessionId: input.sessionId }, "stateful_rp_post_turn_maintenance_failed");
  }
}
