import { extractWindowUsers } from "#conversation/session/historyContext.ts";
import type { InlineSessionTriggerExecution, InternalSessionTriggerExecution, SessionDelivery, SessionReplyTarget } from "#conversation/session/sessionTypes.ts";
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
import { resolveAutoActivatedToolsets } from "./toolsetAutoActivation.ts";
import { supplementPlannedToolsets } from "./toolsetSupplement.ts";
import {
  getProviderTranscriptProjectorForRequest,
  resolveProviderTranscriptProjectorName
} from "./providerTranscriptProjector.ts";
import { createInternalTriggerEvent } from "#conversation/session/internalTranscriptEvents.ts";
import { renderInlineTriggerBatchMessage } from "#llm/prompt/promptBuilder.ts";
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
import { sessionTaskTrackerService } from "#conversation/taskTracker/sessionTaskTrackerService.ts";
import { buildTurnPlannerTaskContext } from "#conversation/taskTracker/taskTrackerPlannerContext.ts";

type ActiveDraftOperation = {
  kind: "persona_setup" | "mode_setup";
  phase: "setup" | "config";
  target: "persona" | "rp" | "scenario";
  promptMode: SessionModeSetupOperation["promptMode"];
  setupToolsetOverrides?: SessionModeSetupOperation["setupToolsetOverrides"];
  completionSignal?: SessionModeSetupOperation["completionSignal"];
  onComplete?: SessionModeSetupOperation["onComplete"];
};

function buildReplyTargetDirective(target: SessionReplyTarget | null): string | null {
  if (!target) {
    return null;
  }
  const lines = [
    "本轮回复目标：",
    `- chat_type: ${target.chatType}`,
    `- user_id: ${target.userId}`,
    `- sender_name: ${target.senderName}`,
    ...(target.groupId ? [`- group_id: ${target.groupId}`] : []),
    `- first_message_at: ${new Date(target.firstMessageAt).toISOString()}`
  ];
  if (target.chatType === "group") {
    lines.push(
      "请回复上述用户本轮在群聊中直接 @/回复 bot 的请求。",
      "其他群成员消息只作为上下文，不要逐一回应，也不要切换本轮回复对象。"
    );
  } else {
    lines.push("请回复上述私聊用户本轮消息。");
  }
  return lines.join("\n");
}

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
  const modeTarget = input.mode.profileAccess.modeProfile;

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
  session: Parameters<GenerationSessionOrchestratorDeps["identity"]["scenarioHostStateStore"]["ensureForSession"]>[0];
  activeDraftOperation: ActiveDraftOperation | null;
  rpProfileStore: GenerationSessionOrchestratorDeps["identity"]["rpProfileStore"];
  scenarioHostStateStore: GenerationSessionOrchestratorDeps["identity"]["scenarioHostStateStore"];
}): Promise<PromptInput["modeProfile"] | undefined> {
  if (input.activeDraftOperation) {
    return undefined;
  }

  if (input.mode.profileAccess.modeProfile === "rp") {
    return {
      target: "rp",
      profile: await input.rpProfileStore.get()
    };
  }

  if (input.mode.profileAccess.modeProfile === "scenario") {
    return {
      target: "scenario",
      profile: (await input.scenarioHostStateStore.ensureForSession(input.session)).profile
    };
  }

  return undefined;
}

function isAssistantMode(modeId: string): boolean {
  return modeId === "assistant";
}

// TODO: Route scheduled/internal triggers through the same toolset activation
// pipeline as normal turns. This hand-maintained list can drift from mode
// eligibility and deterministic auto-activation rules.
function selectScheduledActiveToolsetIds(modeId: string, triggerKind: InternalSessionTriggerExecution["kind"]): string[] {
  const withScenarioHostState = (toolsetIds: string[]): string[] => (
    modeId === "scenario_host"
      ? Array.from(new Set(["scenario_host_state", ...toolsetIds]))
      : toolsetIds
  );
  if (isAssistantMode(modeId)) {
    if (triggerKind === "terminal_session_closed" || triggerKind === "terminal_input_required") {
      return ["chat_context", "shell_runtime", "filesystem_io", "asset_io", "time_utils"];
    }
    if (triggerKind === "download_completed" || triggerKind === "download_failed") {
      return ["chat_context", "web_research", "asset_io", "time_utils"];
    }
    if (triggerKind === "comfy_task_failed") {
      return ["comfy_image"];
    }
    if (triggerKind === "comfy_task_completed") {
      return ["chat_context", "filesystem_io", "asset_io", "comfy_image"];
    }
    return ["chat_context", "web_research", "shell_runtime", "filesystem_io", "asset_io", "scheduler_admin", "time_utils", "comfy_image", "session_mode_control"];
  }
  if (triggerKind === "scheduled_instruction") {
    return withScenarioHostState(["memory_profile", "chat_context", "conversation_navigation", "chat_delegation", "web_research", "filesystem_io", "asset_io", "scheduler_admin", "time_utils"]);
  }
  if (triggerKind === "comfy_task_completed") {
    return withScenarioHostState(["chat_context", "filesystem_io", "asset_io", "comfy_image"]);
  }
  if (triggerKind === "comfy_task_failed") {
    return withScenarioHostState(["comfy_image"]);
  }
  if (triggerKind === "download_completed" || triggerKind === "download_failed") {
    return withScenarioHostState(["chat_context", "web_research", "asset_io", "time_utils"]);
  }
  return withScenarioHostState(["chat_context", "shell_runtime", "filesystem_io", "asset_io", "time_utils"]);
}

function shouldUseSummaryOnlyTranscriptProjector(input: {
  providerName: string;
  enableThinking: boolean;
  visibleToolNames: string[];
}): boolean {
  return input.providerName === "lmstudio"
    && !input.enableThinking
    && input.visibleToolNames.length === 0;
}

function toScheduledPromptTrigger(trigger: InternalSessionTriggerExecution) {
  if (trigger.kind === "scheduled_instruction") {
    return {
      kind: "scheduled_instruction" as const,
      jobName: trigger.jobName,
      taskInstruction: trigger.instruction
    };
  }
  if (trigger.kind === "comfy_task_completed") {
    return {
      kind: "comfy_task_completed" as const,
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
    };
  }
  if (trigger.kind === "comfy_task_failed") {
    return {
      kind: "comfy_task_failed" as const,
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
    };
  }
  if (trigger.kind === "terminal_session_closed") {
    return {
      kind: "terminal_session_closed" as const,
      jobName: trigger.jobName,
      taskInstruction: trigger.instruction,
      resourceId: trigger.resourceId,
      command: trigger.command,
      cwd: trigger.cwd,
      exitCode: trigger.exitCode,
      signal: trigger.signal,
      output: trigger.output,
      outputTruncated: trigger.outputTruncated
    };
  }
  if (trigger.kind === "download_completed") {
    return {
      kind: "download_completed" as const,
      jobName: trigger.jobName,
      taskInstruction: trigger.instruction,
      resourceId: trigger.resourceId,
      sourceUrl: trigger.sourceUrl,
      fileId: trigger.fileId,
      fileRef: trigger.fileRef,
      chatFilePath: trigger.chatFilePath,
      sourceName: trigger.sourceName,
      mimeType: trigger.mimeType,
      sizeBytes: trigger.sizeBytes,
      fileKind: trigger.fileKind
    };
  }
  if (trigger.kind === "download_failed") {
    return {
      kind: "download_failed" as const,
      jobName: trigger.jobName,
      taskInstruction: trigger.instruction,
      resourceId: trigger.resourceId,
      sourceUrl: trigger.sourceUrl,
      error: trigger.error
    };
  }
  return {
    kind: "terminal_input_required" as const,
    jobName: trigger.jobName,
    taskInstruction: trigger.instruction,
    resourceId: trigger.resourceId,
    command: trigger.command,
    cwd: trigger.cwd,
    promptKind: trigger.promptKind,
    promptText: trigger.promptText,
    outputTail: trigger.outputTail
  };
}

// Normalizes runtime messages into the prompt-builder input shape.
function toPromptBatchMessages(messages: GenerationRuntimeBatchMessage[]) {
  return messages.map((message) => ({
    userId: message.userId,
    senderName: message.senderName,
    text: message.text,
    ...(message.contentParts && message.contentParts.length > 0 ? { contentParts: message.contentParts } : {}),
    images: message.images,
    audioSources: message.audioSources,
    audioIds: message.audioIds,
    emojiSources: message.emojiSources,
    imageIds: message.imageIds,
    emojiIds: message.emojiIds,
    ...(message.attachments ? { attachments: message.attachments } : {}),
    ...(message.messageFiles && message.messageFiles.length > 0 ? { messageFiles: message.messageFiles } : {}),
    ...(message.specialSegments && message.specialSegments.length > 0 ? { specialSegments: message.specialSegments } : {}),
    forwardIds: message.forwardIds,
    replyMessageId: message.replyMessageId,
    mentionUserIds: message.mentionUserIds,
    mentionedAll: message.mentionedAll,
    isAtMentioned: message.isAtMentioned,
    receivedAt: message.receivedAt
  }));
}

type PromptBatchMessages = ReturnType<typeof toPromptBatchMessages>;

function applyPromptBatchProjectionToRuntimeMessages(
  messages: GenerationRuntimeBatchMessage[],
  projected: PromptBatchMessages
): GenerationRuntimeBatchMessage[] {
  return messages.map((message, index) => {
    const projection = projected[index];
    if (!projection) {
      return message;
    }
    const projectedMessage = {
      ...message,
      text: projection.text,
      ...(projection.contentParts ? { contentParts: projection.contentParts } : {}),
      audioIds: projection.audioIds,
      audioSources: projection.audioSources,
      imageIds: projection.imageIds,
      emojiIds: projection.emojiIds,
      ...(projection.messageFiles ? { messageFiles: projection.messageFiles } : {}),
      ...(projection.specialSegments ? { specialSegments: projection.specialSegments } : {})
    };
    return Object.prototype.hasOwnProperty.call(projection, "attachments")
      ? { ...projectedMessage, attachments: projection.attachments ?? [] }
      : projectedMessage;
  });
}

async function projectGenerationPromptSafety(input: {
  contentSafetyService: GenerationSessionOrchestratorDeps["promptBuilder"]["contentSafetyService"];
  sessionId: string;
  source: string;
  historyForPrompt: PromptInput["recentMessages"];
  batchMessages: GenerationRuntimeBatchMessage[];
  abortSignal: AbortSignal;
}): Promise<{
  historyForPrompt: PromptInput["recentMessages"];
  promptBatchMessages: PromptBatchMessages;
  runtimeBatchMessages: GenerationRuntimeBatchMessage[];
}> {
  const promptBatchMessages = toPromptBatchMessages(input.batchMessages);
  const projected = await input.contentSafetyService?.projectPromptMessages({
    sessionId: input.sessionId,
    source: input.source,
    recentMessages: input.historyForPrompt,
    batchMessages: promptBatchMessages,
    abortSignal: input.abortSignal
  });
  if (!projected) {
    return {
      historyForPrompt: input.historyForPrompt,
      promptBatchMessages,
      runtimeBatchMessages: input.batchMessages
    };
  }
  return {
    historyForPrompt: projected.recentMessages,
    promptBatchMessages: projected.batchMessages,
    runtimeBatchMessages: applyPromptBatchProjectionToRuntimeMessages(input.batchMessages, projected.batchMessages)
  };
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
    toolRuntime,
    lifecycle
  } = deps;
  const { config } = promptBuilder;
  const { logger, historyCompressor, sessionManager, sessionCaptioner } = sessionRuntime;
  const { userStore, personaStore, globalProfileReadinessStore } = identity;
  const { shellRuntime } = toolRuntime;
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
      const replyTarget = sessionManager.getSession(sessionId).currentReplyTarget;
      const currentTurnDirectives = [buildReplyTargetDirective(replyTarget)].filter((item): item is string => Boolean(item));
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
      const hasRunningResources = await hasRunningResourcesForTaskTracker(toolRuntime);
      const trackerAfterUserBatch = sessionTaskTrackerService.observeUserBatch({
        tracker: refreshedSession.taskTracker,
        messages,
        hasRunningResources
      });
      if (JSON.stringify(trackerAfterUserBatch) !== JSON.stringify(refreshedSession.taskTracker)) {
        sessionManager.setTaskTracker(sessionId, trackerAfterUserBatch);
        persistSession(sessionId, "task_tracker_user_batch_observed");
        refreshedSession = sessionManager.getSession(sessionId);
      }
      const sessionModeId = refreshedSession.modeId;
      const assistantMode = isAssistantMode(sessionModeId);
      const persona = await personaStore.get();
      const mode = requireSessionModeDefinition(sessionModeId);
      const setupCtx = await resolveSessionModeSetupContext(
        sessionModeId,
        sessionId,
        { globalProfileReadinessStore, sessionManager, scenarioHostStateStore: identity.scenarioHostStateStore },
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
      let historyForPrompt = transcriptStore.projectRuntimeHistoryForPrompt({
        excludeGroupId: refreshedSession.activeTranscriptGroupId
      });
      let promptSafety = await projectGenerationPromptSafety({
        contentSafetyService: promptBuilder.contentSafetyService,
        sessionId,
        source: "chat_prompt",
        historyForPrompt,
        batchMessages: messages,
        abortSignal: abortController.signal
      });
      let resolvedModelRef = getModelRefsForRole(config, "main_small");
      const toolVisibilityContext = {
        sessionId,
        replyDelivery: resolvedDelivery
      };
      let plannerToolsets = listTurnToolsets({
        config,
        relationship,
        currentUser: user,
        modelRef: resolvedModelRef,
        includeDebugTools: interactionMode === "debug",
        visibilityContext: toolVisibilityContext,
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
            batchMessages: promptSafety.runtimeBatchMessages,
            availableToolsets: plannerToolsets,
            taskContext: buildTurnPlannerTaskContext(refreshedSession.taskTracker),
            sendTarget: {
              delivery: resolvedDelivery,
              chatType: last.chatType,
              userId: last.userId,
              ...(last.groupId ? { groupId: last.groupId } : {}),
              senderName: last.senderName
            },
            historyForPrompt: promptSafety.historyForPrompt,
            pendingReplyGateWaitPasses,
            abortSignal: abortController.signal
          }
        );
        if (gateResult.plannerDecision?.taskIntent) {
          const latestSession = sessionManager.getSession(sessionId);
          const trackerAfterPlannerIntent = sessionTaskTrackerService.observePlannerTaskIntent({
            tracker: latestSession.taskTracker,
            intent: gateResult.plannerDecision.taskIntent,
            hasRunningResources
          });
          if (JSON.stringify(trackerAfterPlannerIntent) !== JSON.stringify(latestSession.taskTracker)) {
            sessionManager.setTaskTracker(sessionId, trackerAfterPlannerIntent);
            persistSession(sessionId, "task_tracker_planner_intent_observed");
          }
        }
        if (gateResult.action === "skip") {
          if (sessionManager.finishGeneration(sessionId, abortController)) {
            persistSession(sessionId, "generation_finished");
            sessionManager.completeResponse(sessionId, responseEpoch);
            services.processNextSessionWork(sessionId);
          }
          return;
        }
        if (gateResult.topicSwitchCompression) {
          const compressed = await historyCompressor.compactOldHistoryKeepingRecent(
            sessionId,
            gateResult.topicSwitchCompression.preservedMessageCount,
            { triggerReason: "turn_planner_topic_switch" }
          );
          logger.info({
            sessionId,
            preservedMessageCount: gateResult.topicSwitchCompression.preservedMessageCount,
            compressed,
            ...(gateResult.plannerDecision?.reason ? { reason: gateResult.plannerDecision.reason } : {})
          }, "turn_planner_topic_switch_compacted");
          if (compressed) {
            persistSession(sessionId, "turn_planner_topic_switch_compacted");
          }
        }
        resolvedModelRef = gateResult.resolvedModelRef;
        plannerToolsets = listTurnToolsets({
          config,
          relationship,
          currentUser: user,
          modelRef: resolvedModelRef,
          includeDebugTools: interactionMode === "debug",
          visibilityContext: toolVisibilityContext,
          modeId: sessionModeId,
          profileToolScope,
          ...setupPhaseSelection
        });
        plannedToolsetIds = gateResult.toolsetIds.filter((id) => plannerToolsets.some((item) => item.id === id));
        plannerDecision = gateResult.action === "continue" ? gateResult.plannerDecision : undefined;
        refreshedSession = sessionManager.getSession(sessionId);
        transcriptStore = createSessionTranscriptStore(refreshedSession, config);
        historyForPrompt = transcriptStore.projectRuntimeHistoryForPrompt({
          excludeGroupId: refreshedSession.activeTranscriptGroupId
        });
        promptSafety = await projectGenerationPromptSafety({
          contentSafetyService: promptBuilder.contentSafetyService,
          sessionId,
          source: "chat_prompt",
          historyForPrompt,
          batchMessages: messages,
          abortSignal: abortController.signal
        });
        if (plannerToolsets.length === 0) {
          logger.warn({
            sessionId,
            resolvedModelRef,
            relationship,
            supportsTools: getPrimaryModelProfile(config, resolvedModelRef)?.supportsTools ?? null
          }, "turn_planner_available_toolsets_empty_after_routing");
        }
      }
      if (!setupMode && plannerToolsets.length > 0) {
        const autoActivation = resolveAutoActivatedToolsets({
          selectedToolsetIds: plannedToolsetIds,
          availableToolsets: plannerToolsets,
          batchMessages: promptSafety.runtimeBatchMessages,
          recentMessages: promptSafety.historyForPrompt,
          modeId: sessionModeId,
          ...(plannerDecision ? { plannerDecision } : {})
        });
        if (autoActivation.addedToolsetIds.length > 0) {
          logger.info({
            sessionId,
            plannerToolsetIds: plannedToolsetIds,
            autoActivatedToolsetIds: autoActivation.toolsetIds,
            addedToolsetIds: autoActivation.addedToolsetIds,
            reasons: autoActivation.reasons
          }, "turn_toolsets_auto_activated");
          plannedToolsetIds = autoActivation.toolsetIds;
        }
      }
      if (!setupMode && config.llm.turnPlanner.supplementToolsets && plannerToolsets.length > 0) {
        const supplement = supplementPlannedToolsets({
          selectedToolsetIds: plannedToolsetIds,
          availableToolsets: plannerToolsets,
          recentTranscriptItems: transcriptStore.runtimeItems(),
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
      const providerName = resolveProviderTranscriptProjectorName(config, resolvedModelRef);
      const toolNamesFromPlanner = resolveToolNamesFromToolsets(plannerToolsets, plannedToolsetIds);
      const activeChatToolsets = plannerToolsets.filter((toolset) => plannedToolsetIds.includes(toolset.id));
      const chatVisibleToolNames = getBuiltinToolNames(relationship, user, config, {
        modelRef: resolvedModelRef,
        includeDebugTools: interactionMode === "debug",
        visibilityContext: toolVisibilityContext,
        availableToolNames: [...toolNamesFromPlanner, ...TURN_PLANNER_ALWAYS_TOOL_NAMES]
      });
      const debugMarkers = refreshedSession.debugMarkers;
      const replayTranscriptItems = refreshedSession.activeTranscriptGroupId == null
        ? transcriptStore.runtimeItems()
        : transcriptStore.runtimeItems().filter((item) => item.groupId !== refreshedSession.activeTranscriptGroupId);
      const projectedTranscript = getProviderTranscriptProjectorForRequest(providerName, {
        summaryOnly: shouldUseSummaryOnlyTranscriptProjector({
          providerName,
          enableThinking: config.llm.mainRouting.enableThinking,
          visibleToolNames: chatVisibleToolNames
        })
      }).project({
        transcript: replayTranscriptItems,
        preserveThinking: getPrimaryModelProfile(config, resolvedModelRef)?.preserveThinking === true,
        requireThoughtSignatures: config.llm.mainRouting.enableThinking
      });
      const historyForPromptMessages = projectedTranscript.replayCoversVisibleHistory
        ? []
        : promptSafety.historyForPrompt;
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
        session: refreshedSession,
        activeDraftOperation,
        rpProfileStore: identity.rpProfileStore,
        scenarioHostStateStore: identity.scenarioHostStateStore
      });

      const promptBuildResult = isPersonaSetupMode
        ? await services.promptBuilder.buildSetupPromptMessages({
            sessionId,
            interactionMode,
            persona: promptPersona,
            phase: activeDraftOperation?.phase ?? "setup",
            historyForPrompt: historyForPromptMessages,
            debugMarkers,
            internalTranscript: refreshedSession.internalTranscript,
            currentUser: user,
            participantProfiles,
            lastLlmUsage: refreshedSession.lastLlmUsage,
            lateSystemMessages,
            currentTurnDirectives,
            replayMessages: projectedTranscript.replayMessages,
            abortSignal: abortController.signal,
            batchMessages: promptSafety.promptBatchMessages,
            contentSafetyAlreadyProjected: true
          })
        : await services.promptBuilder.buildChatPromptMessages({
            sessionId,
            modeId: sessionModeId,
            interactionMode,
            mainModelRef: resolvedModelRef,
            visibleToolNames: chatVisibleToolNames,
            activeToolsets: activeChatToolsets,
            lateSystemMessages,
            currentTurnDirectives,
            replayMessages: projectedTranscript.replayMessages,
            persona: promptPersona,
            relationship,
            participantProfiles,
            currentUser: user,
            historySummary: refreshedSession.historySummary,
            taskTracker: refreshedSession.taskTracker,
            historyForPrompt: historyForPromptMessages,
            debugMarkers,
            internalTranscript: refreshedSession.internalTranscript,
            lastLlmUsage: refreshedSession.lastLlmUsage,
            abortSignal: abortController.signal,
            batchMessages: promptSafety.promptBatchMessages,
            contentSafetyAlreadyProjected: true,
            ...(modeProfile ? { modeProfile } : {}),
            ...(draftMode ? { draftMode } : {})
          });

      await services.runGeneration({
        sessionId,
        expectedEpoch,
        responseAbortController,
        responseEpoch,
        abortController,
        modeId: sessionModeId,
        relationship,
        interactionMode,
        internalTranscript: refreshedSession.internalTranscript,
        debugMarkers,
        currentUser: user,
        persona,
        batchMessages: promptSafety.runtimeBatchMessages,
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
    if (
      trigger.kind === "terminal_input_required"
      && !shellRuntime.isInputPromptCurrent({
        resourceId: trigger.resourceId,
        promptSignature: trigger.promptSignature,
        detectedAtMs: trigger.detectedAtMs
      })
    ) {
      logger.info({
        sessionId,
        resourceId: trigger.resourceId,
        promptKind: trigger.promptKind,
        detectedAtMs: trigger.detectedAtMs
      }, "terminal_input_trigger_stale_skipped");
      queueMicrotask(() => services.processNextSessionWork(sessionId));
      return Promise.resolve();
    }

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
      const scheduledReplyDelivery = resolveSessionReplyDelivery(sessionId, { trigger });
      const scheduledAvailableToolsets = listTurnToolsets({
        config,
        relationship: "owner",
        currentUser,
        modelRef: scheduledModelRef,
        includeDebugTools: interactionMode === "debug",
        visibilityContext: {
          sessionId,
          replyDelivery: scheduledReplyDelivery
        },
        modeId: session.modeId,
        profileToolScope: resolveProfileToolScope({
          operationMode: session.operationMode,
          activeSetupOperationKind: null,
          modeId: session.modeId
        })
      });
      const activeScheduledToolsetIds = new Set(selectScheduledActiveToolsetIds(session.modeId, trigger.kind));
      const activeScheduledToolsets = scheduledAvailableToolsets.filter((toolset) => activeScheduledToolsetIds.has(toolset.id));
      const scheduledVisibleToolNames = getBuiltinToolNames("owner", currentUser, config, {
        modelRef: scheduledModelRef,
        includeDebugTools: interactionMode === "debug",
        visibilityContext: {
          sessionId,
          replyDelivery: scheduledReplyDelivery
        },
        availableToolNames: resolveToolNamesFromToolsets(
          scheduledAvailableToolsets,
          activeScheduledToolsets.map((toolset) => toolset.id)
        )
      });
      await historyCompressor.maybeCompress(sessionId, { triggerReason: "scheduled_pre_generation" });
      const providerName = resolveProviderTranscriptProjectorName(config, scheduledModelRef);
      const transcriptStore = createSessionTranscriptStore(session, config);
      const projectedHistory = transcriptStore.projectRuntimeHistory();
      const participantProfiles = assistantMode
        ? []
        : await extractWindowUsers(userStore, transcriptStore.runtimeItems(), []);
      const projectedTranscript = getProviderTranscriptProjectorForRequest(providerName, {
        summaryOnly: shouldUseSummaryOnlyTranscriptProjector({
          providerName,
          enableThinking: config.llm.mainRouting.enableThinking,
          visibleToolNames: scheduledVisibleToolNames
        })
      }).project({
        transcript: transcriptStore.runtimeItems(),
        preserveThinking: getPrimaryModelProfile(config, scheduledModelRef)?.preserveThinking === true,
        requireThoughtSignatures: config.llm.mainRouting.enableThinking
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
            session,
            activeDraftOperation: null,
            rpProfileStore: identity.rpProfileStore,
            scenarioHostStateStore: identity.scenarioHostStateStore
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
        trigger: toScheduledPromptTrigger(trigger),
        persona,
        relationship: promptRelationship,
        participantProfiles,
        currentUser,
        historySummary: session.historySummary,
        taskTracker: session.taskTracker,
        historyForPrompt: historyForPromptMessages,
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
        modeId: session.modeId,
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
          delivery: scheduledReplyDelivery satisfies SessionDelivery,
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

  // Runs a batch of background-event inline triggers as a single generation turn.
  // Uses the first trigger for target resolution and toolset selection;
  // the user-visible message renders all triggers via renderInlineTriggerBatchMessage.
  const runInlineTriggerBatchSession = (sessionId: string, triggers: InlineSessionTriggerExecution[]): Promise<void> => {
    const primaryTrigger = triggers[0];
    if (!primaryTrigger) {
      return Promise.resolve();
    }

    const { abortController, responseAbortController, responseEpoch } = sessionManager.beginSyntheticGeneration(sessionId);
    const expectedEpoch = sessionManager.getMutationEpoch(sessionId);
    for (const trigger of triggers) {
      sessionManager.appendInternalTranscript(sessionId, createInternalTriggerEvent({
        trigger,
        stage: "started"
      }));
    }
    persistSession(sessionId, "inline_trigger_batch_started");

    return (async () => {
      const interactionMode: PromptInteractionMode = sessionManager.getDebugControlState(sessionId).enabled ? "debug" : "normal";
      const parsedSession = parseChatSessionIdentity(sessionId);
      const resolvedTargetUserId = primaryTrigger.targetType === "private" && primaryTrigger.targetUserId
        ? (
            parsedSession?.kind === "private"
              ? await resolveInternalUserIdForOneBotPrivateUser({
                  channelId: parsedSession.channelId,
                  externalUserId: primaryTrigger.targetUserId,
                  userIdentityStore: lifecycle.userIdentityStore
                })
              : primaryTrigger.targetUserId
          )
        : null;
      const currentUser = primaryTrigger.targetUserId
        ? await userStore.getByUserId(resolvedTargetUserId ?? primaryTrigger.targetUserId)
        : null;
      const promptRelationship: Relationship = currentUser?.relationship ?? "known";
      const scheduledModelRef = getModelRefsForRole(config, "main_small");
      const session = sessionManager.getSession(sessionId);
      const mode = requireSessionModeDefinition(session.modeId);
      const assistantMode = isAssistantMode(session.modeId);
      const persona = await personaStore.get();
      const scheduledReplyDelivery = resolveSessionReplyDelivery(sessionId, { trigger: primaryTrigger });
      const scheduledAvailableToolsets = listTurnToolsets({
        config,
        relationship: "owner",
        currentUser,
        modelRef: scheduledModelRef,
        includeDebugTools: interactionMode === "debug",
        visibilityContext: {
          sessionId,
          replyDelivery: scheduledReplyDelivery
        },
        modeId: session.modeId,
        profileToolScope: resolveProfileToolScope({
          operationMode: session.operationMode,
          activeSetupOperationKind: null,
          modeId: session.modeId
        })
      });
      const activeScheduledToolsetIds = new Set(selectScheduledActiveToolsetIds(session.modeId, primaryTrigger.kind));
      const activeScheduledToolsets = scheduledAvailableToolsets.filter((toolset) => activeScheduledToolsetIds.has(toolset.id));
      const scheduledVisibleToolNames = getBuiltinToolNames("owner", currentUser, config, {
        modelRef: scheduledModelRef,
        includeDebugTools: interactionMode === "debug",
        visibilityContext: {
          sessionId,
          replyDelivery: scheduledReplyDelivery
        },
        availableToolNames: resolveToolNamesFromToolsets(
          scheduledAvailableToolsets,
          activeScheduledToolsets.map((toolset) => toolset.id)
        )
      });
      await historyCompressor.maybeCompress(sessionId, { triggerReason: "inline_batch_pre_generation" });
      const providerName = resolveProviderTranscriptProjectorName(config, scheduledModelRef);
      const transcriptStore = createSessionTranscriptStore(session, config);
      const projectedHistory = transcriptStore.projectRuntimeHistory();
      const participantProfiles = assistantMode
        ? []
        : await extractWindowUsers(userStore, transcriptStore.runtimeItems(), []);
      const projectedTranscript = getProviderTranscriptProjectorForRequest(providerName, {
        summaryOnly: shouldUseSummaryOnlyTranscriptProjector({
          providerName,
          enableThinking: config.llm.mainRouting.enableThinking,
          visibleToolNames: scheduledVisibleToolNames
        })
      }).project({
        transcript: transcriptStore.runtimeItems(),
        preserveThinking: getPrimaryModelProfile(config, scheduledModelRef)?.preserveThinking === true,
        requireThoughtSignatures: config.llm.mainRouting.enableThinking
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
            session,
            activeDraftOperation: null,
            rpProfileStore: identity.rpProfileStore,
            scenarioHostStateStore: identity.scenarioHostStateStore
          })
        : undefined;
      const inlineBatchMessage = renderInlineTriggerBatchMessage(triggers);
      const promptBuildResult = await services.promptBuilder.buildScheduledPromptMessages({
        sessionId,
        modeId: session.modeId,
        interactionMode,
        visibleToolNames: scheduledVisibleToolNames,
        activeToolsets: activeScheduledToolsets,
        lateSystemMessages,
        replayMessages: projectedTranscript.replayMessages,
        trigger: toScheduledPromptTrigger(primaryTrigger),
        inlineBatchMessage,
        persona,
        relationship: promptRelationship,
        participantProfiles,
        currentUser,
        historySummary: session.historySummary,
        taskTracker: session.taskTracker,
        historyForPrompt: historyForPromptMessages,
        debugMarkers: session.debugMarkers,
        internalTranscript: session.internalTranscript,
        lastLlmUsage: session.lastLlmUsage,
        abortSignal: abortController.signal,
        ...(modeProfile ? { modeProfile } : {}),
        targetContext: primaryTrigger.targetType === "private"
          ? {
              chatType: "private",
              userId: primaryTrigger.targetUserId ?? sessionId,
              senderName: primaryTrigger.targetSenderName
            }
          : {
              chatType: "group",
              groupId: primaryTrigger.targetGroupId ?? sessionId
            }
      });

      await services.runGeneration({
        sessionId,
        expectedEpoch,
        responseAbortController,
        responseEpoch,
        abortController,
        modeId: session.modeId,
        relationship: promptRelationship,
        interactionMode,
        internalTranscript: session.internalTranscript,
        debugMarkers: session.debugMarkers,
        toolRelationship: "owner",
        activeInternalTrigger: primaryTrigger,
        currentUser,
        persona,
        batchMessages: [],
        resolvedModelRef: scheduledModelRef,
        sendTarget: {
          delivery: scheduledReplyDelivery satisfies SessionDelivery,
          chatType: primaryTrigger.targetType,
          userId: primaryTrigger.targetUserId ?? primaryTrigger.targetGroupId ?? sessionId,
          ...(primaryTrigger.targetGroupId ? { groupId: primaryTrigger.targetGroupId } : {}),
          senderName: primaryTrigger.targetSenderName
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
        logger.error({ err: error, sessionId, triggerKinds: triggers.map((t) => t.kind) }, "inline_batch_generation_prepare_failed");
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
    runInternalTriggerSession,
    runInlineTriggerBatchSession
  };
}

async function hasRunningResourcesForTaskTracker(
  toolRuntime: Pick<GenerationSessionOrchestratorDeps["toolRuntime"], "shellRuntime" | "browserService" | "downloadRuntime">
): Promise<boolean> {
  const [browserResult, shellResult] = await Promise.allSettled([
    toolRuntime.browserService?.listPages?.() ?? Promise.resolve({ pages: [] }),
    toolRuntime.shellRuntime?.listSessionResources?.() ?? Promise.resolve([])
  ]);
  if (browserResult.status === "rejected" || shellResult.status === "rejected") {
    return true;
  }
  if (browserResult.value.pages.some((page) => page.status === "active")) {
    return true;
  }
  if (shellResult.value.some((session) => session.status === "active")) {
    return true;
  }
  try {
    return toolRuntime.downloadRuntime?.list?.().some((download) => download.status === "running") ?? false;
  } catch {
    return true;
  }
}
