import type { InternalSessionTriggerExecution } from "#conversation/session/sessionTypes.ts";
import { createInternalTriggerEvent } from "#conversation/session/internalTranscriptEvents.ts";
import { createGenerationExecutor } from "./generationExecutor.ts";
import { createGenerationPromptBuilder } from "./generationPromptBuilder.ts";
import { createGenerationSessionOrchestrator } from "./generationSessionOrchestrator.ts";
import type { GenerationRunnerDeps } from "./generationRunnerDeps.ts";

// Composes the generation pipeline from prompt, execution, and session orchestration pieces.
export function createGenerationRunner(deps: GenerationRunnerDeps) {
  const { logger, sessionManager } = deps.sessionRuntime;

  const promptBuilder = createGenerationPromptBuilder(deps.promptBuilder);

  let flushSessionRef: ((
    sessionId: string,
    options?: {
      skipReplyGate?: boolean;
      delivery?: "onebot" | "web";
      webOutputCollector?: import("./generationTypes.ts").GenerationWebOutputCollector;
    }
  ) => void) | null = null;

  // Resumes queued work after a response finishes or gets interrupted.
  const processNextSessionWork = (sessionId: string) => {
    const session = sessionManager.getSession(sessionId);
    if (sessionManager.hasActiveResponse(sessionId)) {
      return;
    }
    // Steer messages belong to the in-flight turn. Once that turn closes, promote them
    // ahead of queued internal triggers so the next natural user input wins the next slot.
    if (sessionManager.hasPendingSteerMessages(sessionId)) {
      const promoted = sessionManager.promoteSteerMessagesToPending(sessionId);
      if (promoted > 0) {
        logger.info({ sessionId, promotedCount: promoted }, "session_steer_messages_promoted");
      }
    }
    if (session.pendingMessages.length > 0) {
      if (session.debounceTimer != null) {
        logger.debug({ sessionId }, "session_pending_messages_waiting_for_debounce");
        return;
      }
      sessionManager.clearDebounceTimer(sessionId);
      logger.info({ sessionId }, "session_pending_messages_resumed");
      flushSessionRef?.(sessionId);
      return;
    }
    const nextTrigger = sessionManager.shiftInternalTrigger(sessionId);
    if (!nextTrigger) {
      return;
    }
    // Internal triggers only run after visible chat work is drained, so background jobs do
    // not leapfrog fresh user messages or resume while a response is still open.
    logger.info(
      {
        sessionId,
        jobName: nextTrigger.jobName,
        queuedAt: nextTrigger.enqueuedAt,
        triggerKind: nextTrigger.kind
      },
      "internal_trigger_dequeued"
    );
    sessionManager.appendInternalTranscript(sessionId, createInternalTriggerEvent({
      trigger: nextTrigger,
      stage: "dequeued"
    }));
    deps.lifecycle.persistSession(sessionId, "internal_trigger_dequeued");
    void runInternalTriggerSession(sessionId, nextTrigger).then(() => {
      nextTrigger.resolveCompletion?.();
    }).catch((error: unknown) => {
      nextTrigger.rejectCompletion?.(error);
    });
  };

  const generationExecutor = createGenerationExecutor({
    promptBuilder: {
      config: deps.promptBuilder.config,
      mediaVisionService: deps.promptBuilder.mediaVisionService,
      mediaCaptionService: deps.promptBuilder.mediaCaptionService
    },
    sessionRuntime: deps.sessionRuntime,
    identity: deps.identity,
    toolRuntime: deps.toolRuntime,
    lifecycle: deps.lifecycle
  }, {
    processNextSessionWork
  });

  const sessionOrchestrator = createGenerationSessionOrchestrator({
    promptBuilder: {
      config: deps.promptBuilder.config
    },
    sessionRuntime: {
      logger: deps.sessionRuntime.logger,
      historyCompressor: deps.sessionRuntime.historyCompressor,
      llmClient: deps.sessionRuntime.llmClient,
      sessionCaptioner: deps.sessionRuntime.sessionCaptioner,
      turnPlanner: deps.sessionRuntime.turnPlanner,
      debounceManager: deps.sessionRuntime.debounceManager,
      sessionManager: deps.sessionRuntime.sessionManager
    },
    identity: {
      userStore: deps.identity.userStore,
      personaStore: deps.identity.personaStore,
      rpProfileStore: deps.identity.rpProfileStore,
      scenarioProfileStore: deps.identity.scenarioProfileStore,
      setupStore: deps.identity.setupStore,
      scenarioHostStateStore: deps.identity.scenarioHostStateStore,
      globalProfileReadinessStore: deps.identity.globalProfileReadinessStore
    },
    lifecycle: {
      persistSession: deps.lifecycle.persistSession,
      logger: deps.lifecycle.logger,
      sessionManager: deps.lifecycle.sessionManager,
      userStore: deps.lifecycle.userStore,
      getScheduler: deps.lifecycle.getScheduler
    }
  }, {
    promptBuilder,
    runGeneration: generationExecutor.runGeneration,
    processNextSessionWork
  });

  const runInternalTriggerSession = (sessionId: string, trigger: InternalSessionTriggerExecution) => (
    sessionOrchestrator.runInternalTriggerSession(sessionId, trigger)
  );
  // Flushes pending work for a session using the extracted session orchestrator.
  const flushSession = (
    sessionId: string,
    options?: {
      skipReplyGate?: boolean;
      delivery?: "onebot" | "web";
      webOutputCollector?: import("./generationTypes.ts").GenerationWebOutputCollector;
    }
  ) => {
    sessionOrchestrator.flushSession(sessionId, options);
  };
  flushSessionRef = flushSession;

  return {
    flushSession,
    runInternalTriggerSession
  };
}
