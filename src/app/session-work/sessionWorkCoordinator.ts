import { createGenerationRunner } from "../generation/generationRunner.ts";
import { createScheduledTaskDispatcher } from "./scheduledTaskDispatcher.ts";
import type { SessionWorkCoordinatorDeps } from "./sessionWorkShared.ts";

// Joins generation and scheduled-task flows behind a small coordinator interface.
export function createSessionWorkCoordinator(deps: SessionWorkCoordinatorDeps) {
  const generationRunner = createGenerationRunner(deps);
  const scheduledTaskDispatcher = createScheduledTaskDispatcher(deps, {
    runInternalTriggerSession: generationRunner.runInternalTriggerSession
  });

  return {
    dispatchScheduledPrompt: scheduledTaskDispatcher.dispatchScheduledPrompt,
    dispatchInternalTrigger: scheduledTaskDispatcher.dispatchInternalTrigger,
    flushSession: generationRunner.flushSession
  };
}
