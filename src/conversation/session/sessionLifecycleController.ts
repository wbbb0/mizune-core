import {
  beginGenerationState,
  beginSyntheticGenerationState,
  cancelGenerationState,
  completeResponseState,
  finishGenerationState,
  interruptResponseState
} from "./sessionLifecycle.ts";
import { finalizeActiveAssistantResponseState } from "./sessionMutations.ts";
import type { SessionState } from "./sessionTypes.ts";

// Owns session generation/response lifecycle transitions. Keeping these rules in one controller
// makes abort-controller invariants easier to evolve without expanding SessionManager further.
export class SessionLifecycleController {
  beginGeneration(session: SessionState) {
    return beginGenerationState(session);
  }

  beginSyntheticGeneration(session: SessionState) {
    return beginSyntheticGenerationState(session);
  }

  finishGeneration(session: SessionState, abortController: AbortController): boolean {
    return finishGenerationState(session, abortController);
  }

  cancelGeneration(session: SessionState): boolean {
    return cancelGenerationState(session);
  }

  interruptOutbound(session: SessionState): boolean {
    if (session.responseAbortController == null || session.responseAbortController.signal.aborted) {
      return false;
    }
    session.responseAbortController.abort();
    return true;
  }

  interruptResponse(session: SessionState): {
    cancelledGeneration: boolean;
    cancelledOutbound: boolean;
    finalizedAssistant: boolean;
  } {
    const finalizedAssistant = finalizeActiveAssistantResponseState(session, Date.now());
    const interrupted = interruptResponseState(session);
    return {
      ...interrupted,
      finalizedAssistant: finalizedAssistant != null
    };
  }

  completeResponse(session: SessionState, expectedResponseEpoch: number): boolean {
    return completeResponseState(session, expectedResponseEpoch);
  }
}
