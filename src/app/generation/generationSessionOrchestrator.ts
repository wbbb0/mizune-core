import { extractWindowUsers } from "#conversation/session/historyContext.ts";
import type { InternalSessionTriggerExecution, SessionDelivery } from "#conversation/session/sessionTypes.ts";
import { getPrimaryModelProfile } from "#llm/shared/modelProfiles.ts";
import { getModelRefsForRole } from "#llm/shared/modelRouting.ts";
import { getBuiltinToolNames } from "#llm/builtinTools.ts";
import type { PromptInteractionMode } from "#llm/prompt/promptTypes.ts";
import type { Relationship } from "#identity/relationship.ts";
import {
  listTurnToolsets,
  resolveToolNamesFromToolsets,
  TURN_PLANNER_ALWAYS_TOOL_NAMES
} from "#llm/tools/toolsets.ts";
import type { GenerationPromptBuilder } from "./generationPromptBuilder.ts";
import type {
  GenerationSessionOrchestratorDeps,
  GenerationSessionRuntimeDeps
} from "./generationRunnerDeps.ts";
import type { GenerationRuntimeBatchMessage, RunGenerationInput } from "./generationExecutor.ts";
import type {
  GenerationCommittedTextSink,
  GenerationDraftOverlaySink
} from "./generationOutputContracts.ts";
import { handleGenerationTurnPlanner } from "./generationTurnPlanner.ts";
import { supplementPlannedToolsets } from "./toolsetSupplement.ts";
import { getProviderTranscriptProjector } from "./providerTranscriptProjector.ts";
import { createInternalTriggerEvent } from "#conversation/session/internalTranscriptEvents.ts";
import { createSessionTranscriptStore } from "#conversation/session/sessionTranscriptStore.ts";
import { parseChatSessionIdentity } from "#conversation/session/sessionIdentity.ts";
import { requireSessionModeDefinition } from "#modes/registry.ts";
import { resolveSessionModeSetupContext } from "./generationSetupContext.ts";
import { getMissingRpProfileFields, type RpProfile } from "#modes/rpAssistant/profileSchema.ts";
import { getMissingScenarioProfileFields, type ScenarioProfile } from "#modes/scenarioHost/profileSchema.ts";
import { resolveSessionModeSetupOperation } from "#modes/types.ts";
import { resolveInternalUserIdForOneBotPrivateUser } from "#identity/userIdentityResolution.ts";
import type { ProfileToolScope } from "#llm/tools/profileToolScope.ts";
import type { SessionModeDefinition, SessionModeSetupOperation } from "#modes/types.ts";
import type { PromptInput } from "#llm/prompt/promptTypes.ts";

type ActiveDraftOperation = {
  kind: "persona_setup" | "mode_setup";
  phase: "setup" | "config";
  target: "persona" | "rp" | "scenario";
  promptMode: SessionModeSetupOperation["promptMode"];
  setupToolsetOverrides?: SessionModeSetupOperation["setupToolsetOverrides"];
  completionSignal?: SessionModeSetupOperation["completionSignal"];
  onComplete?: SessionModeSetupOperation["onComplete"];
};

function toActiveDraftOperation(input: {
  operation: SessionModeSetupOperation;
  phase: "setup" | "config";
  target: ActiveDraftOperation["target"];
}): ActiveDraftOperation {
  return {
    kind: input.operation.kind,
    phase: input.phase,
    target: input.target,
    promptMode: input.operation.promptMode,
    setupToolsetOverrides: input.operation.setupToolsetOverrides,
    ...(input.phase === "setup"
      ? {
          completionSignal: input.operation.completionSignal,
          onComplete: input.operation.onComplete
        }
      : {})
  };
}

function resolveActiveDraftOperation(input: {
  mode: SessionModeDefinition;
  operationMode: { kind: string; modeId?: string };
  readinessOperation: SessionModeSetupOperation | null;
}): ActiveDraftOperation | null {
  const personaSetupOperation = resolveSessionModeSetupOperation(input.mode.setupPhase, "persona_setup");
  const modeSetupOperation = resolveSessionModeSetupOperation(input.mode.setupPhase, "mode_setup");
  const modeTarget = input.mode.globalProfileAccess.modeProfile;

  switch (input.operationMode.kind) {
    case "persona_setup":
      return personaSetupOperation
        ? toActiveDraftOperation({ operation: personaSetupOperation, phase: "setup", target: "persona" })
        : null;
    case "persona_config":
      return personaSetupOperation
        ? toActiveDraftOperation({ operation: personaSetupOperation, phase: "config", target: "persona" })
        : null;
    case "mode_setup":
      return modeSetupOperation && modeTarget
        ? toActiveDraftOperation({ operation: modeSetupOperation, phase: "setup", target: modeTarget })
        : null;
    case "mode_config":
      return modeSetupOperation && modeTarget
        ? toActiveDraftOperation({ operation: modeSetupOperation, phase: "config", target: modeTarget })
        : null;
    default:
      break;
  }

  if (!input.readinessOperation) {
    return null;
  }
  return toActiveDraftOperation({
    operation: input.readinessOperation,
    phase: "setup",
    target: input.readinessOperation.kind === "persona_setup" ? "persona" : (modeTarget ?? "persona")
  });
}

function resolveProfileToolScope(input: {
  operationMode: { kind: string; modeId?: string };
  activeSetupOperationKind: "persona_setup" | "mode_setup" | null;
  modeId: string;
}): ProfileToolScope {
  if (
    input.activeSetupOperationKind === "persona_setup"
    || input.operationMode.kind === "persona_setup"
    || input.operationMode.kind === "persona_config"
  ) {
    return "persona";
  }
  if (input.operationMode.kind === "mode_setup" || input.operationMode.kind === "mode_config") {
    return input.operationMode.modeId === "rp_assistant" ? "rp" : "scenario";
  }
  return "normal";
}

function resolveDraftModePromptState(input: {
  activeDraftOperation: ActiveDraftOperation | null;
  operationMode: { kind: string; modeId?: string; draft?: unknown };
}): PromptInput["draftMode"] | undefined {
  if (!input.activeDraftOperation || input.activeDraftOperation.target === "persona") {
    return undefined;
  }
  if (input.operationMode.kind !== "mode_setup" && input.operationMode.kind !== "mode_config") {
    return undefined;
  }

  if (input.activeDraftOperation.target === "rp" && input.operationMode.modeId === "rp_assistant") {
    const profile = input.operationMode.draft as RpProfile;
    return {
      target: "rp",
      phase: input.activeDraftOperation.phase,
      profile,
      missingFields: getMissingRpProfileFields(profile)
    };
  }

  if (input.activeDraftOperation.target === "scenario" && input.operationMode.modeId === "scenario_host") {
    const profile = input.operationMode.draft as ScenarioProfile;
    return {
      target: "scenario",
      phase: input.activeDraftOperation.phase,
      profile,
      missingFields: getMissingScenarioProfileFields(profile)
    };
  }

  return undefined;
}

function resolvePromptPersona(input: {
  persona: Awaited<ReturnType<GenerationSessionOrchestratorDeps["identity"]["personaStore"]["get"]>>;
  activeDraftOperation: ActiveDraftOperation | null;
  operationMode: { kind: string; draft?: unknown };
}): Awaited<ReturnType<GenerationSessionOrchestratorDeps["identity"]["personaStore"]["get"]>> {
  if (
    input.activeDraftOperation?.target === "persona"
    && (input.operationMode.kind === "persona_setup" || input.operationMode.kind === "persona_config")
  ) {
    return input.operationMode.draft as Awaited<ReturnType<GenerationSessionOrchestratorDeps["identity"]["personaStore"]["get"]>>;
  }
  return input.persona;
}

async function resolvePromptModeProfile(input: {
  mode: SessionModeDefinition;
  activeDraftOperation: ActiveDraftOperation | null;
  rpProfileStore: GenerationSessionOrchestratorDeps["identity"]["rpProfileStore"];
  scenarioProfileStore: GenerationSessionOrchestratorDeps["identity"]["scenarioProfileStore"];
}): Promise<PromptInput["modeProfile"] | undefined> {
  if (input.activeDraftOperation) {
    return undefined;
  }

  if (input.mode.globalProfileAccess.modeProfile === "rp") {
    return {
      target: "rp",
      profile: await input.rpProfileStore.get()
    };
  }

  if (input.mode.globalProfileAccess.modeProfile === "scenario") {
    return {
      target: "scenario",
      profile: await input.scenarioProfileStore.get()
    };
  }

  return undefined;
}

function isAssistantMode(modeId: string): boolean {
  return modeId === "assistant";
}

function selectScheduledActiveToolsetIds(modeId: string, triggerKind: InternalSessionTriggerExecution["kind"]): string[] {
  if (isAssistantMode(modeId)) {
    if (triggerKind === "comfy_task_failed") {
      return ["comfy_image"];
    }
    if (triggerKind === "comfy_task_completed") {
      return ["chat_context", "local_file_io", "chat_file_io", "comfy_image"];
    }
    return ["chat_context", "web_research", "shell_runtime", "local_file_io", "chat_file_io", "scheduler_admin", "time_utils", "comfy_image", "session_mode_control"];
  }
  if (triggerKind === "scheduled_instruction") {
    return ["memory_profile", "chat_context", "conversation_navigation", "chat_delegation", "web_research", "local_file_io", "chat_file_io", "scheduler_admin", "time_utils"];
  }
  if (triggerKind === "comfy_task_completed") {
    return ["chat_context", "local_file_io", "chat_file_io", "comfy_image"];
  }
  return ["comfy_image"];
}

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

function buildDebugMarkerSystemMessage(markers: ReturnType<GenerationSessionRuntimeDeps["sessionManager"]["getDebugMarkers"]>): string | null {
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
  deps: GenerationSessionOrchestratorDeps,
  services: {
    promptBuilder: GenerationPromptBuilder;
    runGeneration: (input: RunGenerationInput) => Promise<void>;
    processNextSessionWork: (sessionId: string) => void;
  }
) {
  const {
    promptBuilder,
    sessionRuntime,
    identity,
    lifecycle
  } = deps;
  const { config } = promptBuilder;
  const { logger, historyCompressor, sessionManager, sessionCaptioner } = sessionRuntime;
  const { userStore, personaStore, globalProfileReadinessStore } = identity;
  const { persistSession } = lifecycle;

  const resolveSessionReplyDelivery = (
    sessionId: string,
    options?: {
      delivery?: SessionDelivery;
      trigger?: InternalSessionTriggerExecution;
    }
  ): SessionDelivery => {
    if (options?.delivery) {
      return options.delivery;
    }

    if (options?.trigger?.kind === "scheduled_instruction") {
      const delivery = sessionManager.getSession(sessionId).source;
      sessionManager.setReplyDelivery(sessionId, delivery);
      return delivery;
    }

    return sessionManager.getReplyDelivery(sessionId);
  };

  const flushSession = (
    sessionId: string,
    options?: {
      skipReplyGate?: boolean;
      delivery?: "onebot" | "web";
      committedTextSink?: GenerationCommittedTextSink;
      draftOverlaySink?: GenerationDraftOverlaySink;
    }
  ) => {
    const resolvedDelivery = resolveSessionReplyDelivery(sessionId, options);
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
      const user = await userStore.getByUserId(last.userId);
      const relationship: Relationship = user?.relationship ?? "known";
      await historyCompressor.maybeCompress(sessionId, { triggerReason: "pre_generation" });
      let refreshedSession = sessionManager.getSession(sessionId);
      const sessionModeId = refreshedSession.modeId;
      const assistantMode = isAssistantMode(sessionModeId);
      const persona = await personaStore.get();
      const mode = requireSessionModeDefinition(sessionModeId);
      const setupCtx = await resolveSessionModeSetupContext(
        sessionModeId,
        sessionId,
        { globalProfileReadinessStore, sessionManager },
        { chatType: last.chatType, relationship }
      );
      const setupOperationKind = mode.setupPhase?.resolveOperationModeKind(setupCtx) ?? null;
      const readinessSetupOperation = resolveSessionModeSetupOperation(mode.setupPhase, setupOperationKind);
      const activeDraftOperation = resolveActiveDraftOperation({
        mode,
        operationMode: refreshedSession.operationMode,
        readinessOperation: readinessSetupOperation
      });
      const setupMode = activeDraftOperation != null;
      const profileToolScope = resolveProfileToolScope({
        operationMode: refreshedSession.operationMode,
        activeSetupOperationKind: activeDraftOperation?.kind ?? null,
        modeId: sessionModeId
      });
      const setupPhaseSelection = activeDraftOperation?.setupToolsetOverrides
        ? { setupPhase: { setupToolsetOverrides: activeDraftOperation.setupToolsetOverrides } }
        : {};
      let transcriptStore = createSessionTranscriptStore(refreshedSession, config);
      let visibleHistory = transcriptStore.projectRuntimeHistory();
      let historyForPrompt = visibleHistory.slice(0, Math.max(0, visibleHistory.length - messages.length));
      let resolvedModelRef = getModelRefsForRole(config, "main_small");
      let plannerToolsets = listTurnToolsets({
        config,
        relationship,
        currentUser: user,
        modelRef: resolvedModelRef,
        includeDebugTools: interactionMode === "debug",
        modeId: sessionModeId,
        profileToolScope,
        ...setupPhaseSelection
      });
      let plannedToolsetIds = plannerToolsets.map((item) => item.id);
      let plannerDecision = undefined;

      if (!(setupMode || options?.skipReplyGate)) {
        const gateResult = await handleGenerationTurnPlanner(
          {
            config,
            logger,
            llmClient: sessionRuntime.llmClient,
            sessionCaptioner,
            turnPlanner: sessionRuntime.turnPlanner,
            debounceManager: sessionRuntime.debounceManager,
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
            availableToolsets: plannerToolsets,
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
        plannerToolsets = listTurnToolsets({
          config,
          relationship,
          currentUser: user,
          modelRef: resolvedModelRef,
          includeDebugTools: interactionMode === "debug",
          modeId: sessionModeId,
          profileToolScope,
          ...setupPhaseSelection
        });
        plannedToolsetIds = gateResult.toolsetIds.filter((id) => plannerToolsets.some((item) => item.id === id));
        plannerDecision = gateResult.action === "continue" ? gateResult.plannerDecision : undefined;
        refreshedSession = sessionManager.getSession(sessionId);
        transcriptStore = createSessionTranscriptStore(refreshedSession, config);
        visibleHistory = transcriptStore.projectRuntimeHistory();
        historyForPrompt = visibleHistory.slice(0, Math.max(0, visibleHistory.length - messages.length));
        if (plannerToolsets.length === 0) {
          logger.warn({
            sessionId,
            resolvedModelRef,
            relationship,
            supportsTools: getPrimaryModelProfile(config, resolvedModelRef)?.supportsTools ?? null
          }, "turn_planner_available_toolsets_empty_after_routing");
        }
      }
      if (!setupMode && config.llm.turnPlanner.supplementToolsets && plannerToolsets.length > 0) {
        const supplement = supplementPlannedToolsets({
          selectedToolsetIds: plannedToolsetIds,
          availableToolsets: plannerToolsets,
          batchMessages: messages,
          recentToolEvents: refreshedSession.recentToolEvents,
          ...(plannerDecision ? { plannerDecision } : {})
        });
        if (supplement.addedToolsetIds.length > 0) {
          logger.info({
            sessionId,
            plannerToolsetIds: plannedToolsetIds,
            supplementedToolsetIds: supplement.toolsetIds,
            addedToolsetIds: supplement.addedToolsetIds,
            reasons: supplement.reasons
          }, "turn_planner_toolsets_supplemented");
        }
        plannedToolsetIds = supplement.toolsetIds;
      }
      const participantProfiles = assistantMode
        ? []
        : await extractWindowUsers(userStore, transcriptStore.runtimeItems(), messages.map((message) => ({
            userId: message.userId,
            senderName: message.senderName
          })));
      const providerName = getPrimaryModelProfile(config, resolvedModelRef)?.provider ?? "unknown";
      const toolNamesFromPlanner = resolveToolNamesFromToolsets(plannerToolsets, plannedToolsetIds);
      const activeChatToolsets = plannerToolsets.filter((toolset) => plannedToolsetIds.includes(toolset.id));
      const chatVisibleToolNames = getBuiltinToolNames(relationship, user, config, {
        modelRef: resolvedModelRef,
        includeDebugTools: interactionMode === "debug",
        availableToolNames: [...toolNamesFromPlanner, ...TURN_PLANNER_ALWAYS_TOOL_NAMES]
      });
      const recentToolEvents = refreshedSession.recentToolEvents;
      const debugMarkers = refreshedSession.debugMarkers;
      const replayTranscriptItems = refreshedSession.activeTranscriptGroupId == null
        ? transcriptStore.runtimeItems()
        : transcriptStore.runtimeItems().filter((item) => item.groupId !== refreshedSession.activeTranscriptGroupId);
      const projectedTranscript = getProviderTranscriptProjector(providerName).project({
        transcript: replayTranscriptItems,
        preserveThinking: getPrimaryModelProfile(config, resolvedModelRef)?.preserveThinking === true
      });
      const historyForPromptMessages = projectedTranscript.replayCoversVisibleHistory ? [] : historyForPrompt;
      const lateSystemMessages = [
        ...projectedTranscript.lateSystemMessages,
        ...(interactionMode === "debug"
          ? [buildDebugMarkerSystemMessage(debugMarkers)].filter((item): item is string => Boolean(item))
          : [])
      ];
      const isPersonaSetupMode = activeDraftOperation?.promptMode === "persona_setup";
      const draftMode = resolveDraftModePromptState({
        activeDraftOperation,
        operationMode: refreshedSession.operationMode
      });
      const promptPersona = resolvePromptPersona({
        persona,
        activeDraftOperation,
        operationMode: refreshedSession.operationMode
      });
      const modeProfile = await resolvePromptModeProfile({
        mode,
        activeDraftOperation,
        rpProfileStore: identity.rpProfileStore,
        scenarioProfileStore: identity.scenarioProfileStore
      });

      const promptBuildResult = isPersonaSetupMode
        ? await services.promptBuilder.buildSetupPromptMessages({
            sessionId,
            interactionMode,
            persona: promptPersona,
            phase: activeDraftOperation?.phase ?? "setup",
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
            modeId: sessionModeId,
            interactionMode,
            mainModelRef: resolvedModelRef,
            visibleToolNames: chatVisibleToolNames,
            activeToolsets: activeChatToolsets,
            lateSystemMessages,
            replayMessages: projectedTranscript.replayMessages,
            persona: promptPersona,
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
            batchMessages: toPromptBatchMessages(messages),
            ...(modeProfile ? { modeProfile } : {}),
            ...(draftMode ? { draftMode } : {})
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
        ...(setupMode
          ? {
              availableToolNames: plannerToolsets.flatMap((t) => t.toolNames),
              setupMode: true,
              ...(activeDraftOperation?.phase === "setup"
                ? {
                    setupCompletionSignal: activeDraftOperation.completionSignal,
                    setupOnComplete: activeDraftOperation.onComplete
                  }
                : {})
            }
          : {
              plannedToolsetIds,
              availableToolsets: plannerToolsets,
              forceRegenerateTitleAfterTurn: plannerDecision?.topicDecision === "new_topic"
            }),
        streamResponse: true,
        ...(options?.committedTextSink ? { committedTextSink: options.committedTextSink } : {}),
        ...(options?.draftOverlaySink ? { draftOverlaySink: options.draftOverlaySink } : {})
      });
    })().catch((error: unknown) => {
      if (sessionManager.isGenerating(sessionId)) {
        logger.error({ err: error, sessionId }, "generation_prepare_failed");
        if (sessionManager.finishGeneration(sessionId, abortController)) {
          persistSession(sessionId, "generation_finished");
          sessionManager.completeResponse(sessionId, responseEpoch);
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
      const interactionMode: PromptInteractionMode = sessionManager.getDebugControlState(sessionId).enabled ? "debug" : "normal";
      const parsedSession = parseChatSessionIdentity(sessionId);
      const resolvedTargetUserId = trigger.targetType === "private" && trigger.targetUserId
        ? (
            parsedSession?.kind === "private"
              ? await resolveInternalUserIdForOneBotPrivateUser({
                  channelId: parsedSession.channelId,
                  externalUserId: trigger.targetUserId,
                  userIdentityStore: lifecycle.userIdentityStore
                })
              : trigger.targetUserId
          )
        : null;
      const currentUser = trigger.targetUserId
        ? await userStore.getByUserId(resolvedTargetUserId ?? trigger.targetUserId)
        : null;
      const promptRelationship: Relationship = currentUser?.relationship ?? "known";
      const scheduledModelRef = getModelRefsForRole(config, "main_small");
      const session = sessionManager.getSession(sessionId);
      const mode = requireSessionModeDefinition(session.modeId);
      const assistantMode = isAssistantMode(session.modeId);
      const persona = await personaStore.get();
      const scheduledAvailableToolsets = listTurnToolsets({
        config,
        relationship: "owner",
        currentUser,
        modelRef: scheduledModelRef,
        includeDebugTools: interactionMode === "debug",
        modeId: session.modeId,
        profileToolScope: resolveProfileToolScope({
          operationMode: session.operationMode,
          activeSetupOperationKind: null,
          modeId: session.modeId
        })
      });
      const activeScheduledToolsetIds = new Set(selectScheduledActiveToolsetIds(session.modeId, trigger.kind));
      const activeScheduledToolsets = scheduledAvailableToolsets.filter((toolset) => activeScheduledToolsetIds.has(toolset.id));
      const scheduledVisibleToolNames = resolveToolNamesFromToolsets(
        scheduledAvailableToolsets,
        activeScheduledToolsets.map((toolset) => toolset.id)
      );
      await historyCompressor.maybeCompress(sessionId, { triggerReason: "scheduled_pre_generation" });
      const providerName = getPrimaryModelProfile(config, scheduledModelRef)?.provider ?? "unknown";
      const transcriptStore = createSessionTranscriptStore(session, config);
      const projectedHistory = transcriptStore.projectRuntimeHistory();
      const participantProfiles = assistantMode
        ? []
        : await extractWindowUsers(userStore, transcriptStore.runtimeItems(), []);
      const projectedTranscript = getProviderTranscriptProjector(providerName).project({
        transcript: transcriptStore.runtimeItems(),
        preserveThinking: getPrimaryModelProfile(config, scheduledModelRef)?.preserveThinking === true
      });
      const historyForPromptMessages = projectedTranscript.replayCoversVisibleHistory ? [] : projectedHistory;
      const lateSystemMessages = [
        ...projectedTranscript.lateSystemMessages,
        ...(interactionMode === "debug"
          ? [buildDebugMarkerSystemMessage(session.debugMarkers)].filter((item): item is string => Boolean(item))
          : [])
      ];
      const modeProfile = session.operationMode.kind === "normal"
        ? await resolvePromptModeProfile({
            mode,
            activeDraftOperation: null,
            rpProfileStore: identity.rpProfileStore,
            scenarioProfileStore: identity.scenarioProfileStore
          })
        : undefined;
      const promptBuildResult = await services.promptBuilder.buildScheduledPromptMessages({
        sessionId,
        modeId: session.modeId,
        interactionMode,
        visibleToolNames: scheduledVisibleToolNames,
        activeToolsets: activeScheduledToolsets,
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
                workspaceFileIds: trigger.workspaceFileIds,
                chatFilePaths: trigger.chatFilePaths,
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
        ...(modeProfile ? { modeProfile } : {}),
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
          delivery: resolveSessionReplyDelivery(sessionId, { trigger }) satisfies SessionDelivery,
          chatType: trigger.targetType,
          userId: trigger.targetUserId ?? trigger.targetGroupId ?? sessionId,
          ...(trigger.targetGroupId ? { groupId: trigger.targetGroupId } : {}),
          senderName: trigger.targetSenderName
        },
        participantProfiles,
        promptMessages: promptBuildResult.promptMessages,
        debugSnapshot: promptBuildResult.debugSnapshot,
        plannedToolsetIds: activeScheduledToolsets.map((toolset) => toolset.id),
        availableToolsets: scheduledAvailableToolsets,
        streamResponse: false
      });
    })().catch((error: unknown) => {
      if (sessionManager.isGenerating(sessionId)) {
        logger.error({ err: error, sessionId, triggerKind: trigger.kind, jobName: trigger.jobName }, "scheduled_generation_prepare_failed");
        if (sessionManager.finishGeneration(sessionId, abortController)) {
          persistSession(sessionId, "generation_finished");
          sessionManager.completeResponse(sessionId, responseEpoch);
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
