import {
  appendDebugMarkerState,
  setSessionDebugControlState
} from "./sessionMutations.ts";
import type {
  SessionDebugControlState,
  SessionDebugMarker,
  SessionState
} from "./sessionTypes.ts";

// Owns session-local debug toggles and markers so debug-only behavior stays grouped
// instead of being scattered across the main session manager surface.
export class SessionDebugController {
  appendMarker(session: SessionState, marker: SessionDebugMarker): void {
    appendDebugMarkerState(session, marker);
  }

  getMarkers(session: SessionState): SessionDebugMarker[] {
    return [...session.debugMarkers];
  }

  getControlState(session: SessionState): SessionDebugControlState {
    return { ...session.debugControl };
  }

  setEnabled(session: SessionState, enabled: boolean): SessionDebugControlState {
    return setSessionDebugControlState(session, {
      enabled,
      ...(enabled ? {} : { oncePending: false })
    });
  }

  armOnce(session: SessionState): SessionDebugControlState {
    return setSessionDebugControlState(session, { oncePending: true });
  }

  consume(session: SessionState): boolean {
    const active = session.debugControl.enabled || session.debugControl.oncePending;
    if (session.debugControl.oncePending) {
      setSessionDebugControlState(session, { oncePending: false });
    }
    return active;
  }
}
