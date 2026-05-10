import {
  drainInlineTriggersState,
  enqueueInlineTriggerState
} from "./sessionMutations.ts";
import type { InlineSessionTriggerExecution, SessionState } from "./sessionTypes.ts";

// Owns queue-like operations for background-event inline triggers that are
// meant to be injected inside the active tool-call loop instead of opening a
// brand new session.
export class SessionInlineTriggerQueue {
  hasPending(session: SessionState): boolean {
    return session.pendingInlineTriggers.length > 0;
  }

  getSize(session: SessionState): number {
    return session.pendingInlineTriggers.length;
  }

  enqueue(session: SessionState, trigger: InlineSessionTriggerExecution): number {
    return enqueueInlineTriggerState(session, trigger);
  }

  drainAll(session: SessionState): InlineSessionTriggerExecution[] {
    return drainInlineTriggersState(session);
  }
}
