import {
  popRetractableSentMessagesState,
  recordSentMessageState
} from "./sessionMutations.ts";
import type { SessionSentMessage, SessionState } from "./sessionTypes.ts";

// Owns outbound message bookkeeping used by retract and admin/debug flows.
// This keeps retention-window behavior out of SessionManager's main control surface.
export class SessionSentMessageLog {
  record(session: SessionState, message: SessionSentMessage): void {
    recordSentMessageState(session, message);
  }

  popRetractable(session: SessionState, count: number, maxAgeMs: number, now = Date.now()): SessionSentMessage[] {
    return popRetractableSentMessagesState(session, count, maxAgeMs, now);
  }
}
