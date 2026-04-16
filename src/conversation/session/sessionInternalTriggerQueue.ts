import {
  enqueueInternalTriggerState,
  shiftInternalTriggerState
} from "./sessionMutations.ts";
import type { InternalSessionTriggerExecution, SessionState } from "./sessionTypes.ts";

// Owns queue-like operations for deferred internal triggers so callers stop reasoning about
// the raw pendingInternalTriggers array directly.
export class SessionInternalTriggerQueue {
  hasPending(session: SessionState): boolean {
    return session.pendingInternalTriggers.length > 0;
  }

  getSize(session: SessionState): number {
    return session.pendingInternalTriggers.length;
  }

  enqueue(session: SessionState, trigger: InternalSessionTriggerExecution): number {
    return enqueueInternalTriggerState(session, trigger);
  }

  shift(session: SessionState): InternalSessionTriggerExecution | null {
    return shiftInternalTriggerState(session);
  }
}
