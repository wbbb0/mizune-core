import type { SessionState } from "./sessionTypes.ts";

// This store owns only the in-memory session map. Higher-level session behavior stays outside the store
// so later refactors can split lifecycle/history/control concerns without re-entangling storage concerns.
export class SessionStore {
  private readonly sessions = new Map<string, SessionState>();

  get(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  set(sessionId: string, session: SessionState): void {
    this.sessions.set(sessionId, session);
  }

  delete(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  values(): IterableIterator<SessionState> {
    return this.sessions.values();
  }
}
