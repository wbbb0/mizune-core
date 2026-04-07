import type { InternalSessionTriggerExecution } from "#conversation/session/sessionManager.ts";
import { createInternalTriggerEvent } from "#conversation/session/internalTranscriptEvents.ts";
import { createGenerationExecutor } from "./generationExecutor.ts";
import { createGenerationPromptBuilder } from "./generationPromptBuilder.ts";
import { createGenerationSessionOrchestrator } from "./generationSessionOrchestrator.ts";
import type { GenerationRunnerDeps } from "./generationRunnerDeps.ts";

// Composes the generation pipeline from prompt, execution, and session orchestration pieces.
export function createGenerationRunner(deps: GenerationRunnerDeps) {
  const { logger, sessionManager } = deps;

  const promptBuilder = createGenerationPromptBuilder({
    config: deps.config,
    oneBotClient: deps.oneBotClient,
    audioStore: deps.audioStore,
    audioTranscriber: deps.audioTranscriber,
    npcDirectory: deps.npcDirectory,
    setupStore: deps.setupStore,
    browserService: deps.browserService,
    shellRuntime: deps.shellRuntime,
    workspaceService: deps.workspaceService,
    mediaWorkspace: deps.mediaWorkspace,
    mediaVisionService: deps.mediaVisionService,
    mediaCaptionService: deps.mediaCaptionService,
    globalMemoryStore: deps.globalMemoryStore
  });

  let flushSessionRef: ((
    sessionId: string,
    options?: {
      skipReplyGate?: boolean;
      delivery?: "onebot" | "web";
      webOutputCollector?: import("./generationExecutor.ts").GenerationWebOutputCollector;
    }
  ) => void) | null = null;

  // Resumes queued work after a response finishes or gets interrupted.
  const processNextSessionWork = (sessionId: string) => {
    const session = sessionManager.getSession(sessionId);
    if (sessionManager.hasActiveResponse(sessionId)) {
      return;
    }
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
    deps.persistSession(sessionId, "internal_trigger_dequeued");
    void runInternalTriggerSession(sessionId, nextTrigger).then(() => {
      nextTrigger.resolveCompletion?.();
    }).catch((error: unknown) => {
      nextTrigger.rejectCompletion?.(error);
    });
  };

  const generationExecutor = createGenerationExecutor(deps, {
    processNextSessionWork
  });

  const sessionOrchestrator = createGenerationSessionOrchestrator(deps, {
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
      webOutputCollector?: import("./generationExecutor.ts").GenerationWebOutputCollector;
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
