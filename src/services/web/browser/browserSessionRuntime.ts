import type { BrowserBackend, BrowserSnapshot } from "./types.ts";

export interface BrowserSessionInit {
  backend: BrowserBackend;
  state: unknown;
  snapshot: BrowserSnapshot;
  expiresAt: number;
  ownerSessionId: string | null;
  profileId: string | null;
}

export interface BrowserSessionRecord extends BrowserSessionInit {
  resourceId: string;
}

export class BrowserSessionRuntime {
  private readonly sessions = new Map<string, BrowserSessionRecord>();
  private readonly pendingDisposals = new Set<BrowserSessionRecord>();
  private openingCount = 0;

  constructor(private readonly maxSessions: number) {}

  reserveOpen(): (() => void) | null {
    if (this.sessions.size + this.pendingDisposals.size + this.openingCount >= this.maxSessions) {
      return null;
    }
    this.openingCount += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.openingCount -= 1;
      }
    };
  }

  set(resourceId: string, init: BrowserSessionInit): BrowserSessionRecord {
    if (this.sessions.has(resourceId) || this.findPendingDisposal(resourceId)) {
      throw new Error(`Browser resource is already tracked: ${resourceId}`);
    }
    const session = {
      ...init,
      resourceId
    };
    this.sessions.set(resourceId, session);
    return session;
  }

  get(resourceId: string): BrowserSessionRecord | undefined {
    return this.sessions.get(resourceId);
  }

  beginDisposal(session: BrowserSessionRecord): void {
    if (this.sessions.get(session.resourceId) === session) {
      this.sessions.delete(session.resourceId);
    }
    this.pendingDisposals.add(session);
  }

  completeDisposal(session: BrowserSessionRecord): void {
    this.pendingDisposals.delete(session);
  }

  findPendingDisposal(resourceId: string): BrowserSessionRecord | undefined {
    for (const session of this.pendingDisposals) {
      if (session.resourceId === resourceId) {
        return session;
      }
    }
    return undefined;
  }

  pending(): BrowserSessionRecord[] {
    return Array.from(this.pendingDisposals);
  }

  all(): BrowserSessionRecord[] {
    return [...this.sessions.values(), ...this.pendingDisposals];
  }

  values(): BrowserSessionRecord[] {
    return Array.from(this.sessions.values());
  }

  touch(resourceId: string, expiresAt: number): BrowserSessionRecord | null {
    const session = this.sessions.get(resourceId);
    if (!session) {
      return null;
    }
    session.expiresAt = expiresAt;
    return session;
  }

  findByProfileId(profileId: string): BrowserSessionRecord | null {
    for (const session of this.sessions.values()) {
      if (session.profileId === profileId) {
        return session;
      }
    }
    return null;
  }

  collectExpired(now: number): BrowserSessionRecord[] {
    const expired: BrowserSessionRecord[] = [];
    for (const session of this.sessions.values()) {
      if (session.expiresAt <= now) {
        expired.push(session);
      }
    }
    for (const session of expired) {
      this.beginDisposal(session);
    }
    return expired;
  }
}
