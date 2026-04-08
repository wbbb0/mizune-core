import type { BrowserBackend, BrowserSnapshot } from "./types.ts";

export interface BrowserSessionRecord {
  resourceId: string;
  backend: BrowserBackend;
  state: unknown;
  snapshot: BrowserSnapshot;
  expiresAt: number;
  ownerSessionId: string | null;
  profileId: string | null;
}

export interface BrowserSessionInit {
  backend: BrowserBackend;
  state: unknown;
  snapshot: BrowserSnapshot;
  expiresAt: number;
  ownerSessionId: string | null;
  profileId: string | null;
}

export class BrowserSessionRuntime {
  private readonly sessions = new Map<string, BrowserSessionRecord>();

  constructor(private readonly maxSessions: number) {}

  set(resourceId: string, init: BrowserSessionInit): BrowserSessionRecord[] {
    this.sessions.set(resourceId, {
      resourceId,
      ...init
    });
    return this.evictOverflow();
  }

  get(resourceId: string): BrowserSessionRecord | undefined {
    return this.sessions.get(resourceId);
  }

  delete(resourceId: string): BrowserSessionRecord | undefined {
    const existing = this.sessions.get(resourceId);
    if (!existing) {
      return undefined;
    }
    this.sessions.delete(resourceId);
    return existing;
  }

  clear(): BrowserSessionRecord[] {
    const existing = Array.from(this.sessions.values());
    this.sessions.clear();
    return existing;
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
      this.sessions.delete(session.resourceId);
    }
    return expired;
  }

  private evictOverflow(): BrowserSessionRecord[] {
    const evicted: BrowserSessionRecord[] = [];
    while (this.sessions.size > this.maxSessions) {
      const firstKey = this.sessions.keys().next().value;
      if (!firstKey) {
        break;
      }
      const session = this.sessions.get(firstKey);
      this.sessions.delete(firstKey);
      if (session) {
        evicted.push(session);
      }
    }
    return evicted;
  }
}
