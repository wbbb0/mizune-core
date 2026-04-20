import { createBuiltinToolExecutor, getBuiltinTools } from "#llm/builtinTools.ts";
import type { LlmMessage, LlmToolCall, LlmToolExecutionResult } from "#llm/llmClient.ts";
import { splitReadySegments } from "#llm/shared/streamSplitter.ts";
import { extractToolError, parseToolArguments } from "#llm/shared/toolArgs.ts";
import type { Relationship } from "#identity/relationship.ts";
import {
  createUserTranscriptMessageItem,
  projectTranscriptMessageItemToHistoryMessage
} from "#conversation/session/historyContext.ts";
import {
  createGenerationFailureFallbackEvent,
  createModelFallbackEvent,
  formatErrorDetails
} from "#conversation/session/internalTranscriptEvents.ts";
import { buildBuiltinToolContext, type PromptDebugSnapshot } from "#llm/tools/core/shared.ts";
import type { PromptInteractionMode } from "#llm/prompt/promptTypes.ts";
import { createGenerationOutbound } from "./generationOutbound.ts";
import { createGenerationTypingWindow } from "./generationTypingWindow.ts";
import type { GenerationPromptParticipantProfile } from "./generationPromptBuilder.ts";
import type {
  GenerationCurrentUser,
  GenerationExecutorDeps,
  GenerationPersona
} from "./generationRunnerDeps.ts";
import type { InternalSessionTriggerExecution, InternalTranscriptItem, SessionDebugMarker } from "#conversation/session/sessionTypes.ts";
import type { ChatAttachment } from "#services/workspace/types.ts";
import {
  buildGenerationFailureAssistantMessage,
  extractToolContent,
  summarizeResultText,
  summarizeToolArgs,
  summarizeToolResult
} from "./generationExecutorSupport.ts";
import type { GenerationWebOutputCollector } from "./generationTypes.ts";
import {
  resolveToolNamesFromToolsets,
  TURN_PLANNER_ALWAYS_TOOL_NAMES
} from "#llm/tools/toolsets.ts";
import type { ToolsetView } from "#llm/tools/toolsetCatalog.ts";
import { listSessionModes, requireSessionModeDefinition } from "#modes/registry.ts";
import { checkSetupCompletion } from "./generationSetupContext.ts";
import { waitForGenerationAbortGraceWindow } from "#app/runtime/runtimeTimingPolicy.ts";
import { maybeAutoCaptionSessionTitle } from "./sessionCaptioner.ts";

export interface GenerationRuntimeBatchMessage {
  chatType: "private" | "group";
  userId: string;
  senderName: string;
  text: string;
  images: string[];
  audioSources: string[];
  audioIds: string[];
  emojiSources: string[];
  imageIds: string[];
  emojiIds: string[];
  attachments?: ChatAttachment[];
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
  streamResponse?: boolean | undefined;
  webOutputCollector?: GenerationWebOutputCollector | undefined;
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
        webOutputCollector
      } = input;
    let outboundDrainPromise: Promise<void> | null = null;
    let lastResultReasoningContent = "";
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
      let streamBuffer = "";
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
            ...(webOutputCollector ? { webOutputCollector } : {})
          }
      );
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

      const resolveAllowedTools = () => getBuiltinTools(toolRelationship ?? relationship, currentUser, config, {
        modelRef: resolvedModelRef,
        includeDebugTools: interactionMode === "debug",
        ...(resolveDynamicAllowedToolNames().length > 0
          ? { availableToolNames: resolveDynamicAllowedToolNames() }
          : {})
      });

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
        mediaVisionService,
        mediaCaptionService,
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
        personaStore,
        globalRuleStore,
        toolsetRuleStore,
        scenarioHostStateStore,
        setupStore,
        conversationAccess,
        npcDirectory,
        ...(toolsetAccess ? { toolsetAccess } : {}),
        debugSnapshot,
        persistSession,
        listSessionModes,
        ...(webOutputCollector ? { webOutputCollector } : {}),
        ...(activeInternalTrigger !== undefined ? { activeInternalTrigger } : {})
      });

      const toolExecutor = async (toolCall: LlmToolCall): Promise<string | LlmToolExecutionResult> => {
        const args = parseToolArguments(toolCall.function.arguments || "{}", logger, {
          toolName: toolCall.function.name,
          toolCallId: toolCall.id
        });
        try {
          const rawToolExecutor = createBuiltinToolExecutor(builtinToolContext, {
            modelRef: resolvedModelRef,
            includeDebugTools: interactionMode === "debug",
            ...(resolveDynamicAllowedToolNames().length > 0
              ? { availableToolNames: resolveDynamicAllowedToolNames() }
              : {})
          });
          const result = await rawToolExecutor(toolCall, args);
          const eventApplied = sessionManager.appendToolEventIfEpochMatches(sessionId, expectedEpoch, {
            toolName: toolCall.function.name,
            argsSummary: summarizeToolArgs(args),
            outcome: extractToolError(extractToolContent(result)) ? "error" : "success",
            resultSummary: summarizeToolResult(result),
            timestampMs: Date.now()
          });
          if (eventApplied) {
            persistSession(sessionId, "tool_event_recorded");
          }
          return result;
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          const eventApplied = sessionManager.appendToolEventIfEpochMatches(sessionId, expectedEpoch, {
            toolName: toolCall.function.name,
            argsSummary: summarizeToolArgs(args),
            outcome: "error",
            resultSummary: summarizeResultText(message, 220),
            timestampMs: Date.now()
          });
          if (eventApplied) {
            persistSession(sessionId, "tool_event_recorded");
          }
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
      };

      if (llmClient.isConfigured(resolvedModelRef)) {
        try {
          sessionManager.setSessionPhaseIfEpochMatches(sessionId, expectedEpoch, { kind: "requesting_llm" });
          const result = await llmClient.generate({
            messages: promptMessages,
            modelRefOverride: resolvedModelRef,
            enableThinkingOverride: config.llm.mainRouting.enableThinking,
            tools: resolveAllowedTools,
            abortSignal: abortController.signal,
            consumeSteerMessages,
            toolExecutor: async (toolCall) => {
              sessionManager.setSessionPhaseIfEpochMatches(sessionId, expectedEpoch, {
                kind: "tool_calling",
                toolNames: [toolCall.function.name],
                lastToolName: toolCall.function.name
              });
              const res = await toolExecutor(toolCall);
              sessionManager.setSessionPhaseIfEpochMatches(sessionId, expectedEpoch, { kind: "requesting_llm" });
              return res;
            },
            onAssistantToolCalls: async (message) => {
              const applied = sessionManager.appendInternalTranscriptIfEpochMatches(sessionId, expectedEpoch, {
                kind: "assistant_tool_call",
                llmVisible: true,
                timestampMs: Date.now(),
                content: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
                toolCalls: message.tool_calls ?? [],
                ...(typeof message.reasoning_content === "string" ? { reasoningContent: message.reasoning_content } : {}),
                ...(message.providerMetadata ? { providerMetadata: message.providerMetadata } : {})
              });
              if (applied) {
                persistSession(sessionId, "internal_transcript_updated");
              }
            },
            onToolResultMessage: async (message, toolName) => {
              const content = typeof message.content === "string"
                ? message.content
                : JSON.stringify(message.content);
              const applied = sessionManager.appendInternalTranscriptIfEpochMatches(sessionId, expectedEpoch, {
                kind: "tool_result",
                llmVisible: true,
                timestampMs: Date.now(),
                toolCallId: message.tool_call_id ?? "",
                toolName,
                content
              });
              if (applied) {
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
                    streamBuffer += delta;
                    if (disableStreamingSplit) {
                      return;
                    }
                    const split = splitReadySegments(streamBuffer);
                    streamBuffer = split.rest;
                    for (const chunk of split.ready) {
                      await outbound.enqueueChunk(chunk.text, {
                        joinWithDoubleNewline: chunk.joinWithDoubleNewline
                      });
                    }
                  }
                })
          });
          summary = result.text;
          lastResultReasoningContent = result.reasoningContent ?? "";
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
          if (streamBuffer.trim()) {
            await outbound.enqueueChunk(streamBuffer);
            streamBuffer = "";
          }
          await outbound.enqueueChunk(failureMessage, {
            joinWithDoubleNewline: outbound.hasSentAssistantChunk()
          });
          summary = "";
        }
      } else {
        summary = "LLM 未配置。请在 LLM catalog 文件中填写 provider 与 model 清单，在运行时配置中设置 llm.mainRouting.smallModelRef/largeModelRef，并将 llm.enabled 设为 true。";
      }

      streamBuffer = await outbound.flushBufferedOutput(summary, streamBuffer, streamResponse);
      outboundDrainPromise = outbound.getDrainPromise();

      persistSession(sessionId, "generation_completed");
    } catch (error: unknown) {
      logger.error({ err: error, sessionId }, "generation_failed");
      throw error;
    } finally {
      const finishedCurrent = sessionManager.finishGeneration(sessionId, abortController);
      if (finishedCurrent && setupMode) {
        const modeId = sessionManager.getModeId(sessionId);
        const modeDef = requireSessionModeDefinition(modeId);
        if (modeDef.setupPhase) {
          const isComplete = await checkSetupCompletion(
            modeDef.setupPhase.completionSignal,
            sessionId,
            { setupStore, scenarioHostStateStore, sessionManager }
          );
          if (isComplete && modeDef.setupPhase.onComplete === "clear_session") {
            sessionManager.clearSession(sessionId);
            persistSession(sessionId, "setup_completed_session_cleared");
          }
        }
      }

      if (!sessionManager.isResponseOpen(sessionId, responseEpoch)) {
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
        const sessionAfterCompletion = sessionManager.getSession(sessionId);
        if (sessionAfterCompletion.source === "web" && sessionAfterCompletion.titleSource === "default") {
          await maybeAutoCaptionSessionTitle({
            sessionId,
            sessionManager,
            sessionCaptioner,
            persistSession,
            logger,
            reason: "generation_completed_captioned"
          });
        }
        if (
          sendTarget.chatType === "private"
          && sessionManager.getSession(sessionId).pendingMessages.length === 0
          && !sessionManager.hasActiveResponse(sessionId)
        ) {
          void historyCompressor.maybeCompress(sessionId).then((compressed) => {
            if (compressed) {
              persistSession(sessionId, "post_response_history_compressed");
            }
          }).catch((error: unknown) => {
            logger.warn({ err: error, sessionId }, "post_response_history_compression_failed");
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
