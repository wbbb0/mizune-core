import { extractWindowUsers } from "#conversation/session/historyContext.ts";
import type { InternalSessionTriggerExecution } from "#conversation/session/sessionManager.ts";
import { getDefaultMainModelRefs, getPrimaryModelProfile } from "#llm/shared/modelProfiles.ts";
import { getBuiltinToolNames } from "#llm/builtinTools.ts";
import type { PromptInteractionMode } from "#llm/prompt/promptTypes.ts";
import type { Relationship } from "#identity/relationship.ts";
import type { GenerationPromptBuilder } from "./generationPromptBuilder.ts";
import type { GenerationRunnerDeps } from "./generationRunnerDeps.ts";
import type { GenerationRuntimeBatchMessage } from "./generationExecutor.ts";
import type { RunGenerationInput } from "./generationExecutor.ts";
import type { GenerationWebOutputCollector } from "./generationExecutor.ts";
import { handleGenerationReplyGate } from "./generationReplyGate.ts";
import { getProviderTranscriptProjector } from "./providerTranscriptProjector.ts";
import { createInternalTriggerEvent } from "#conversation/session/internalTranscriptEvents.ts";
import { projectLlmVisibleHistoryFromTranscript } from "#conversation/session/sessionTranscript.ts";

// Normalizes runtime messages into the prompt-builder input shape.
function toPromptBatchMessages(messages: GenerationRuntimeBatchMessage[]) {
  return messages.map((message) => ({
    userId: message.userId,
    senderName: message.senderName,
    text: message.text,
    images: message.images,
    audioSources: message.audioSources,
    audioIds: message.audioIds,
    emojiSources: message.emojiSources,
    imageIds: message.imageIds,
    emojiIds: message.emojiIds,
    ...(message.attachments ? { attachments: message.attachments } : {}),
    forwardIds: message.forwardIds,
    replyMessageId: message.replyMessageId,
    mentionUserIds: message.mentionUserIds,
    mentionedAll: message.mentionedAll,
    isAtMentioned: message.isAtMentioned,
    receivedAt: message.receivedAt
  }));
}

function buildDebugMarkerSystemMessage(markers: ReturnType<GenerationRunnerDeps["sessionManager"]["getDebugMarkers"]>): string | null {
  if (markers.length === 0) {
    return null;
  }

  const lines = markers.slice(-6).map((marker) => {
    const parts: string[] = [marker.kind];
    if (marker.literals && marker.literals.length > 0) {
      parts.push(`literals=${marker.literals.join(",")}`);
    }
    if (typeof marker.sentCount === "number") {
      parts.push(`sent=${marker.sentCount}`);
    }
    if (marker.note) {
      parts.push(`note=${marker.note}`);
    }
    return `- ${parts.join(" | ")}`;
  });
  return `最近 debug markers（元数据；不要对用户直说）：\n${lines.join("\n")}`;
}

// Prepares session state and prompt inputs before delegating to the executor.
export function createGenerationSessionOrchestrator(
  deps: GenerationRunnerDeps,
  services: {
    promptBuilder: GenerationPromptBuilder;
    runGeneration: (input: RunGenerationInput) => Promise<void>;
    processNextSessionWork: (sessionId: string) => void;
  }
) {
  const {
    config,
    logger,
    historyCompressor,
    sessionManager,
    userStore,
    personaStore,
    setupStore,
    persistSession
  } = deps;

  const flushSession = (
    sessionId: string,
    options?: {
      skipReplyGate?: boolean;
      delivery?: "onebot" | "web";
      webOutputCollector?: GenerationWebOutputCollector;
    }
  ) => {
    const resolvedDelivery = options?.delivery ?? sessionManager.getLastInboundDelivery(sessionId);
    const { messages, pendingReplyGateWaitPasses, abortController, responseAbortController, responseEpoch } = sessionManager.beginGeneration(sessionId);
    const expectedEpoch = sessionManager.getMutationEpoch(sessionId);
    if (messages.length === 0) {
      if (sessionManager.finishGeneration(sessionId, abortController)) {
        sessionManager.completeResponse(sessionId, responseEpoch);
        services.processNextSessionWork(sessionId);
      }
      return;
    }

    void (async () => {
      const last = messages[messages.length - 1];
      if (!last) {
        if (sessionManager.finishGeneration(sessionId, abortController)) {
          sessionManager.completeResponse(sessionId, responseEpoch);
          services.processNextSessionWork(sessionId);
        }
        return;
      }
      const interactionMode: PromptInteractionMode = sessionManager.consumeDebugMode(sessionId) ? "debug" : "normal";
      const persona = await personaStore.get();
      const user = await userStore.getByUserId(last.userId);
      const relationship: Relationship = user?.relationship ?? "known";
      await historyCompressor.maybeCompress(sessionId);
      const setupState = await setupStore.get();
      const setupMode = setupState.state !== "ready" && last.chatType === "private" && relationship === "owner";
      let refreshedSession = sessionManager.getSession(sessionId);
      let visibleHistory = projectLlmVisibleHistoryFromTranscript(refreshedSession.internalTranscript, config);
      let historyForPrompt = visibleHistory.slice(0, Math.max(0, visibleHistory.length - messages.length));
      let resolvedModelRef = getDefaultMainModelRefs(config);
      if (!(setupMode || options?.skipReplyGate)) {
        const gateResult = await handleGenerationReplyGate(
          {
            config,
            logger,
            llmClient: deps.llmClient,
            replyGate: deps.replyGate,
            debounceManager: deps.debounceManager,
            historyCompressor,
            sessionManager,
            persistSession
          },
          {
            flushSession: (targetSessionId: string) => {
              flushSession(targetSessionId);
            }
          },
          {
            sessionId,
            relationship,
            currentUser: user,
            batchMessages: messages,
            sendTarget: {
              delivery: resolvedDelivery,
              chatType: last.chatType,
              userId: last.userId,
              ...(last.groupId ? { groupId: last.groupId } : {}),
              senderName: last.senderName
            },
            historyForPrompt,
            pendingReplyGateWaitPasses,
            abortSignal: abortController.signal
          }
        );
        if (gateResult.action === "skip") {
          if (sessionManager.finishGeneration(sessionId, abortController)) {
            persistSession(sessionId, "generation_finished");
            sessionManager.completeResponse(sessionId, responseEpoch);
            services.processNextSessionWork(sessionId);
          }
          return;
        }
        resolvedModelRef = gateResult.resolvedModelRef;
        refreshedSession = sessionManager.getSession(sessionId);
        visibleHistory = projectLlmVisibleHistoryFromTranscript(refreshedSession.internalTranscript, config);
        historyForPrompt = visibleHistory.slice(0, Math.max(0, visibleHistory.length - messages.length));
      }
      const participantProfiles = await extractWindowUsers(userStore, refreshedSession.internalTranscript, messages.map((message) => ({
          userId: message.userId,
          senderName: message.senderName
        })));
      const providerName = getPrimaryModelProfile(config, resolvedModelRef)?.provider ?? "unknown";
      const chatVisibleToolNames = getBuiltinToolNames(relationship, user, config, {
        modelRef: resolvedModelRef,
        includeDebugTools: interactionMode === "debug"
      });
      const recentToolEvents = refreshedSession.recentToolEvents;
      const debugMarkers = refreshedSession.debugMarkers;
      const projectedTranscript = getProviderTranscriptProjector(providerName).project({
        transcript: refreshedSession.internalTranscript
      });
      const historyForPromptMessages = projectedTranscript.replayCoversVisibleHistory ? [] : historyForPrompt;
      const lateSystemMessages = [
        ...projectedTranscript.lateSystemMessages,
        ...(interactionMode === "debug"
          ? [buildDebugMarkerSystemMessage(debugMarkers)].filter((item): item is string => Boolean(item))
          : [])
      ];
      const promptBuildResult = setupMode
        ? await services.promptBuilder.buildSetupPromptMessages({
            sessionId,
            interactionMode,
            persona,
            historyForPrompt: historyForPromptMessages,
            recentToolEvents,
            debugMarkers,
            internalTranscript: refreshedSession.internalTranscript,
            currentUser: user,
            participantProfiles,
            lastLlmUsage: refreshedSession.lastLlmUsage,
            lateSystemMessages,
            replayMessages: projectedTranscript.replayMessages,
            abortSignal: abortController.signal,
            batchMessages: toPromptBatchMessages(messages)
          })
        : await services.promptBuilder.buildChatPromptMessages({
            sessionId,
            interactionMode,
            mainModelRef: resolvedModelRef,
            visibleToolNames: chatVisibleToolNames,
            lateSystemMessages,
            replayMessages: projectedTranscript.replayMessages,
            persona,
            relationship,
            participantProfiles,
            currentUser: user,
            historySummary: refreshedSession.historySummary,
            historyForPrompt: historyForPromptMessages,
            recentToolEvents,
            debugMarkers,
            internalTranscript: refreshedSession.internalTranscript,
            lastLlmUsage: refreshedSession.lastLlmUsage,
            abortSignal: abortController.signal,
            batchMessages: toPromptBatchMessages(messages)
          });

      await services.runGeneration({
        sessionId,
        expectedEpoch,
        responseAbortController,
        responseEpoch,
        abortController,
        relationship,
        interactionMode,
        internalTranscript: refreshedSession.internalTranscript,
        debugMarkers,
        currentUser: user,
        persona,
        batchMessages: messages,
        sendTarget: {
          delivery: resolvedDelivery,
          chatType: last.chatType,
          userId: last.userId,
          ...(last.groupId ? { groupId: last.groupId } : {}),
          senderName: last.senderName
        },
        participantProfiles,
        promptMessages: promptBuildResult.promptMessages,
        resolvedModelRef,
        debugSnapshot: promptBuildResult.debugSnapshot,
        ...(setupMode ? { availableToolNames: ["get_persona", "update_persona"], setupMode: true } : {}),
        streamResponse: resolvedDelivery === "web" ? false : true,
        ...(options?.webOutputCollector ? { webOutputCollector: options.webOutputCollector } : {})
      });
    })().catch((error: unknown) => {
      if (sessionManager.getSession(sessionId).isGenerating) {
        logger.error({ err: error, sessionId }, "generation_prepare_failed");
        if (sessionManager.finishGeneration(sessionId, abortController)) {
          persistSession(sessionId, "generation_finished");
          services.processNextSessionWork(sessionId);
        }
      }
    });
  };

  const runInternalTriggerSession = (sessionId: string, trigger: InternalSessionTriggerExecution): Promise<void> => {
    const { abortController, responseAbortController, responseEpoch } = sessionManager.beginSyntheticGeneration(sessionId);
    const expectedEpoch = sessionManager.getMutationEpoch(sessionId);
    sessionManager.appendInternalTranscript(sessionId, createInternalTriggerEvent({
      trigger,
      stage: "started"
    }));
    persistSession(sessionId, "internal_trigger_started");

    return (async () => {
      const persona = await personaStore.get();
      const interactionMode: PromptInteractionMode = sessionManager.getDebugControlState(sessionId).enabled ? "debug" : "normal";
      const currentUser = trigger.targetUserId
        ? await userStore.getByUserId(trigger.targetUserId)
        : null;
      const promptRelationship: Relationship = currentUser?.relationship ?? "known";
      const scheduledModelRef = getDefaultMainModelRefs(config);
      const scheduledVisibleToolNames = getBuiltinToolNames("owner", currentUser, config, {
        modelRef: scheduledModelRef,
        includeDebugTools: interactionMode === "debug"
      });
      await historyCompressor.maybeCompress(sessionId);
      const session = sessionManager.getSession(sessionId);
      const providerName = getPrimaryModelProfile(config, scheduledModelRef)?.provider ?? "unknown";
      const projectedHistory = projectLlmVisibleHistoryFromTranscript(session.internalTranscript, config);
      const participantProfiles = await extractWindowUsers(userStore, session.internalTranscript, []);
      const projectedTranscript = getProviderTranscriptProjector(providerName).project({
        transcript: session.internalTranscript
      });
      const historyForPromptMessages = projectedTranscript.replayCoversVisibleHistory ? [] : projectedHistory;
      const lateSystemMessages = [
        ...projectedTranscript.lateSystemMessages,
        ...(interactionMode === "debug"
          ? [buildDebugMarkerSystemMessage(session.debugMarkers)].filter((item): item is string => Boolean(item))
          : [])
      ];
      const promptBuildResult = await services.promptBuilder.buildScheduledPromptMessages({
        sessionId,
        interactionMode,
        visibleToolNames: scheduledVisibleToolNames,
        lateSystemMessages,
        replayMessages: projectedTranscript.replayMessages,
        trigger: trigger.kind === "scheduled_instruction"
          ? {
              kind: "scheduled_instruction",
              jobName: trigger.jobName,
              taskInstruction: trigger.instruction
            }
          : trigger.kind === "comfy_task_completed"
            ? {
                kind: "comfy_task_completed",
                jobName: trigger.jobName,
                taskInstruction: trigger.instruction,
                taskId: trigger.taskId,
                templateId: trigger.templateId,
                positivePrompt: trigger.positivePrompt,
                aspectRatio: trigger.aspectRatio,
                resolvedWidth: trigger.resolvedWidth,
                resolvedHeight: trigger.resolvedHeight,
                workspaceAssetIds: trigger.workspaceAssetIds,
                workspacePaths: trigger.workspacePaths,
                comfyPromptId: trigger.comfyPromptId,
                autoIterationIndex: trigger.autoIterationIndex,
                maxAutoIterations: trigger.maxAutoIterations
              }
            : {
                kind: "comfy_task_failed",
                jobName: trigger.jobName,
                taskInstruction: trigger.instruction,
                taskId: trigger.taskId,
                templateId: trigger.templateId,
                positivePrompt: trigger.positivePrompt,
                aspectRatio: trigger.aspectRatio,
                resolvedWidth: trigger.resolvedWidth,
                resolvedHeight: trigger.resolvedHeight,
                comfyPromptId: trigger.comfyPromptId,
                lastError: trigger.lastError,
                autoIterationIndex: trigger.autoIterationIndex,
                maxAutoIterations: trigger.maxAutoIterations
              },
        persona,
        relationship: promptRelationship,
        participantProfiles,
        currentUser,
        historySummary: session.historySummary,
        historyForPrompt: historyForPromptMessages,
        recentToolEvents: session.recentToolEvents,
        debugMarkers: session.debugMarkers,
        internalTranscript: session.internalTranscript,
        lastLlmUsage: session.lastLlmUsage,
        abortSignal: abortController.signal,
        targetContext: trigger.targetType === "private"
          ? {
              chatType: "private",
              userId: trigger.targetUserId ?? sessionId,
              senderName: trigger.targetSenderName
            }
          : {
              chatType: "group",
              groupId: trigger.targetGroupId ?? sessionId
            }
      });

      await services.runGeneration({
        sessionId,
        expectedEpoch,
        responseAbortController,
        responseEpoch,
        abortController,
        relationship: promptRelationship,
        interactionMode,
        internalTranscript: session.internalTranscript,
        debugMarkers: session.debugMarkers,
        toolRelationship: "owner",
        activeInternalTrigger: trigger,
        currentUser,
        persona,
        batchMessages: [],
        resolvedModelRef: scheduledModelRef,
        sendTarget: {
          delivery: "onebot",
          chatType: trigger.targetType,
          userId: trigger.targetUserId ?? trigger.targetGroupId ?? sessionId,
          ...(trigger.targetGroupId ? { groupId: trigger.targetGroupId } : {}),
          senderName: trigger.targetSenderName
        },
        participantProfiles,
        promptMessages: promptBuildResult.promptMessages,
        debugSnapshot: promptBuildResult.debugSnapshot,
        streamResponse: false
      });
    })().catch((error: unknown) => {
      if (sessionManager.getSession(sessionId).isGenerating) {
        logger.error({ err: error, sessionId, triggerKind: trigger.kind, jobName: trigger.jobName }, "scheduled_generation_prepare_failed");
        if (sessionManager.finishGeneration(sessionId, abortController)) {
          persistSession(sessionId, "generation_finished");
          services.processNextSessionWork(sessionId);
        }
      }
      throw error;
    });
  };

  return {
    flushSession,
    runInternalTriggerSession
  };
}
