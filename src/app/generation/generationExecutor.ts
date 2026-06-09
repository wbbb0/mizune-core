import { createBuiltinToolExecutor, getBuiltinTools } from "#llm/builtinTools.ts";
import type { LlmMessage, LlmProviderCallUsage, LlmToolCall, LlmToolExecutionResult } from "#llm/llmClient.ts";
import { createEmptyUsage, mergeUsage } from "#llm/provider/providerTypes.ts";
import { getRoutingPresetTokenLimits } from "#llm/shared/modelRouting.ts";
import { parseToolArguments } from "#llm/shared/toolArgs.ts";
import type { Relationship } from "#identity/relationship.ts";
import {
  createUserTranscriptMessageItem,
  projectTranscriptMessageItemToHistoryMessage
} from "#conversation/session/historyContext.ts";
import { buildToolObservation } from "#conversation/session/toolObservation.ts";
import {
  createContextExtractionEvent,
  createGenerationFailureFallbackEvent,
  createInternalTriggerEvent,
  createModelFallbackEvent,
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
import { projectProviderWorkingMessagesForBudget } from "./providerWorkingMessageBudget.ts";
import { sessionTaskTrackerService } from "#conversation/taskTracker/sessionTaskTrackerService.ts";
import type { SessionTaskTracker } from "#conversation/taskTracker/taskTrackerTypes.ts";

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
  debugSnapshot: PromptDebugSnapshot;
  availableToolNames?: string[] | undefined;
  plannedToolsetIds?: string[] | undefined;
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
    let lastResultReasoningContent = "";
    let finalProviderCallUsage: LlmProviderCallUsage | null = null;
    const runningProviderUsage = createEmptyUsage(resolvedModelRef[0] ?? null, null);
    const recordProviderCallUsage = (event: LlmProviderCallUsage): void => {
      mergeUsage(runningProviderUsage, event.usage);
      const usageApplied = sessionManager.setLastLlmUsageIfEpochMatches(sessionId, expectedEpoch, {
        ...runningProviderUsage,
        capturedAt: Date.now()
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
    // 消费 steer 消息，注入到当前 tool iteration 的 prompt 上下文中。
    // 如果仅注入用户消息效果不够明显（模型没有及时收尾），
    // 可以在这里额外附加一条 system 提示，告知模型"用户发了新消息，请尽快结束当前工具链"。
    const consumeSteerMessages = async (): Promise<LlmMessage[]> => {
      const steerMessages = sessionManager.consumeSteerMessages(sessionId);
      if (steerMessages.length === 0) {
        return [];
      }
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
      const isPlannerToolsetMode = !setupMode && Array.isArray(availableToolsets) && availableToolsets.length > 0;
      const activeToolsetIds = new Set((plannedToolsetIds ?? []).filter((id) => (
        availableToolsets?.some((item) => item.id === id) ?? false
      )));
      let toolsetUpgradeUsed = false;

      const resolveDynamicAllowedToolNames = (): string[] => {
        if (!isPlannerToolsetMode) {
          return availableToolNames ?? [];
        }
        return [
          ...resolveToolNamesFromToolsets(availableToolsets!, Array.from(activeToolsetIds)),
          ...TURN_PLANNER_ALWAYS_TOOL_NAMES
        ];
      };

      const buildToolSelectionOptions = () => {
        const dynamicAllowedToolNames = resolveDynamicAllowedToolNames();
        return {
          modelRef: resolvedModelRef,
          includeDebugTools: interactionMode === "debug",
          visibilityContext: {
            sessionId,
            replyDelivery: sendTarget.delivery
          },
          ...(dynamicAllowedToolNames.length > 0
            ? { availableToolNames: dynamicAllowedToolNames }
            : {})
        };
      };
      let toolBudgetToolsDisabled = false;
      const resolveAllowedTools = () => toolBudgetToolsDisabled
        ? []
        : getBuiltinTools(
            toolRelationship ?? relationship,
            currentUser,
            config,
            buildToolSelectionOptions()
          );

      const toolsetAccess = isPlannerToolsetMode
        ? {
            listAvailableToolsets: () => ({
              available_toolsets: availableToolsets!.map((toolset) => ({
                id: toolset.id,
                title: toolset.title,
                description: toolset.description,
                tools: toolset.toolNames
              })),
              active_toolset_ids: Array.from(activeToolsetIds),
              request_limit_per_turn: 1,
              remaining_request_quota: toolsetUpgradeUsed ? 0 : 1
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
              if (toolsetUpgradeUsed) {
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
        ...(structuredSuggestionService ? { structuredSuggestionService } : {}),
        setupStore,
        globalProfileReadinessStore,
        conversationAccess,
        npcDirectory,
        userIdentityStore: lifecycle.userIdentityStore,
        ...(toolsetAccess ? { toolsetAccess } : {}),
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
          const rawToolExecutor = createBuiltinToolExecutor(builtinToolContext, buildToolSelectionOptions());
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
          const activeToolCounts = new Map<string, number>();
          const listActiveToolNames = () => [...activeToolCounts.entries()]
            .filter(([, count]) => count > 0)
            .map(([name]) => name);
          sessionManager.setSessionPhaseIfEpochMatches(sessionId, expectedEpoch, { kind: "requesting_llm" });
          const result = await llmClient.generate({
            messages: promptMessages,
            modelRefOverride: resolvedModelRef,
            enableThinkingOverride: config.llm.mainRouting.enableThinking,
            tools: resolveAllowedTools,
            abortSignal: abortController.signal,
            consumeSteerMessages,
            consumeInlineTriggers,
            projectMessagesBeforeProvider: async (messages) => {
              assertGenerationCurrent();
              const projectedMessages = await projectProviderPreflightMessages({
                messages,
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
              const projection = projectProviderWorkingMessagesForBudget({
                messages: projectedMessages,
                transcript: sessionManager.getSession(sessionId).internalTranscript,
                config,
                triggerTokens: getRoutingPresetTokenLimits(config).triggerTokens
              });
              toolBudgetToolsDisabled = projection.toolsDisabled;
              if (projection.compactedToolResults > 0 || projection.toolsDisabled) {
                logger.info(
                  {
                    sessionId,
                    beforeTokens: projection.beforeTokens,
                    afterTokens: projection.afterTokens,
                    compactedToolResults: projection.compactedToolResults,
                    toolsDisabled: projection.toolsDisabled
                  },
                  "provider_working_messages_budget_projected"
                );
              }
              return projection.messages;
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
                timestampMs: Date.now(),
                toolCallId,
                toolName,
                content,
                ...(resultMetadata?.canonicalContent !== undefined ? { canonicalContent: resultMetadata.canonicalContent } : {}),
                observation
              });
              if (applied) {
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
                  nowMs: Date.now()
                }), "task_tracker_tool_result_observed");
                persistSession(sessionId, "internal_transcript_updated");
              }
            },
            onFallbackEvent: async (event) => {
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
            },
            ...(streamResponse === false
              ? {}
                : {
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
          summary = result.text;
          lastResultReasoningContent = result.reasoningContent ?? "";
          finalProviderCallUsage = [...(result.providerCallUsages ?? [])].reverse()
            .find((event) => event.phase === "final_response" || event.phase === "fallback_response" || event.phase === "terminal_response")
            ?? null;
          const usageApplied = sessionManager.setLastLlmUsageIfEpochMatches(sessionId, expectedEpoch, {
            ...result.usage,
            capturedAt: Date.now()
          });
          if (usageApplied) {
            persistSession(sessionId, "llm_usage_updated");
          } else {
            logger.info({ sessionId, expectedEpoch }, "llm_usage_update_skipped_epoch_mismatch");
          }
        } catch (error: unknown) {
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

      persistSession(sessionId, "generation_completed");
    } catch (error: unknown) {
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
        let captionForceRegenerate = forceRegenerateTitleAfterTurn === true;
        if (
          sendTarget.chatType === "private"
          && sessionManager.getSession(sessionId).pendingMessages.length === 0
          && !sessionManager.hasActiveResponse(sessionId)
        ) {
          try {
            const compressed = await historyCompressor.maybeCompress(sessionId, { triggerReason: "post_response" });
            if (compressed) {
              captionForceRegenerate = true;
              persistSession(sessionId, "post_response_history_compressed");
            }
          } catch (error: unknown) {
            logger.warn({ err: error, sessionId }, "post_response_history_compression_failed");
          }
        }
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
