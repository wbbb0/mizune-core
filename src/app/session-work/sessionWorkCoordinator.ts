import { createGenerationRunner } from "../generation/generationRunner.ts";
import type { GenerationRunnerDeps } from "../generation/generationRunnerDeps.ts";
import { createScheduledTaskDispatcher } from "./scheduledTaskDispatcher.ts";

type SessionWorkCoordinatorDeps = GenerationRunnerDeps;

// Joins generation and scheduled-task flows behind a small coordinator interface.
export function createSessionWorkCoordinator(deps: SessionWorkCoordinatorDeps) {
  const generationRunner = createGenerationRunner(deps);
  const scheduledTaskDispatcher = createScheduledTaskDispatcher(deps.lifecycle, {
    runInternalTriggerSession: generationRunner.runInternalTriggerSession,
    wakeInlineBatch: (sessionId: string) => {
      generationRunner.processNextSessionWork(sessionId);
    }
  });

  return {
    dispatchScheduledPrompt: scheduledTaskDispatcher.dispatchScheduledPrompt,
    dispatchInternalTrigger: scheduledTaskDispatcher.dispatchInternalTrigger,
    dispatchTerminalEvent: scheduledTaskDispatcher.dispatchTerminalEvent,
    dispatchDownloadEvent: scheduledTaskDispatcher.dispatchDownloadEvent,
    dispatchComfyEvent: scheduledTaskDispatcher.dispatchComfyEvent,
    flushSession: generationRunner.flushSession
  };
}
