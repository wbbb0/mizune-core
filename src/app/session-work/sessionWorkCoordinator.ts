import { createGenerationRunner } from "../generation/generationRunner.ts";
import type { GenerationRunnerRuntimeDeps } from "../generation/generationRunnerDeps.ts";
import { createScheduledTaskDispatcher } from "./scheduledTaskDispatcher.ts";

type SessionWorkCoordinatorDeps = GenerationRunnerRuntimeDeps;

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
