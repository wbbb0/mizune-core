import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { BrowserResourceSync } from "./browserResourceSync.ts";
import { BrowserSessionRuntime, type BrowserSessionRecord } from "./browserSessionRuntime.ts";

type BrowserProfilePersistence = {
  persistSessionProfile(session: BrowserSessionRecord): Promise<void>;
};

type SessionDisposal = {
  status: "closed" | "expired" | null;
  persistProfile: boolean;
  backendClosed: boolean;
  promise: Promise<void> | null;
};

export class BrowserSessionJanitor {
  private readonly disposals = new WeakMap<BrowserSessionRecord, SessionDisposal>();

  constructor(
    private readonly deps: {
      config: AppConfig;
      logger: Logger;
      sessions: BrowserSessionRuntime;
      resourceSync: BrowserResourceSync;
    },
    private readonly profilePersistence: BrowserProfilePersistence
  ) {}

  computeNextExpiry(): number {
    return Date.now() + this.deps.config.browser.sessionTtlMs;
  }

  async requireSession(resourceId: string, options?: { touch?: boolean }): Promise<BrowserSessionRecord> {
    const session = this.deps.sessions.get(resourceId);
    if (!session) {
      if (!this.deps.sessions.findPendingDisposal(resourceId)) {
        await this.deps.resourceSync.markMissingAsExpired(resourceId);
      }
      throw new Error(`Unknown resource_id: ${resourceId}`);
    }
    if (options?.touch !== false) {
      const nextExpiry = this.computeNextExpiry();
      const touched = this.deps.sessions.touch(resourceId, nextExpiry);
      if (!touched) {
        throw new Error(`Unknown resource_id: ${resourceId}`);
      }
      await this.deps.resourceSync.touchPage(resourceId, touched);
      return touched;
    }
    return session;
  }

  async reserveOpen(): Promise<() => void> {
    // Failed disposals keep their capacity until a later cleanup succeeds.
    if (this.deps.sessions.pending().length > 0) {
      throw new Error("Browser cleanup is still pending; retry after the resources can be closed");
    }
    let release = this.deps.sessions.reserveOpen();
    while (!release) {
      const oldest = this.deps.sessions.values()[0];
      if (!oldest) {
        throw new Error("Browser session capacity is exhausted by pages being opened or closed");
      }
      await this.disposeSession(oldest, "expired");
      release = this.deps.sessions.reserveOpen();
    }
    return release;
  }

  async cleanupExpiredSessions(): Promise<void> {
    const expired = this.deps.sessions.collectExpired(Date.now());
    await Promise.allSettled(this.deps.sessions.pending().map((session) => this.disposeSession(session, "expired")));
    const stillPending = new Set(this.deps.sessions.pending());
    this.deps.resourceSync.logExpiredSessions(expired.filter((session) => !stillPending.has(session)).length);
  }

  async closeSession(resourceId: string): Promise<void> {
    const session = this.deps.sessions.get(resourceId) ?? this.deps.sessions.findPendingDisposal(resourceId);
    if (!session) {
      throw new Error(`Unknown resource_id: ${resourceId}`);
    }
    await this.disposeSession(session, "closed");
  }

  async closeAllSessions(logEvent: string): Promise<void> {
    const sessions = this.deps.sessions.all();
    const results = await Promise.allSettled(sessions.map((session) => this.disposeSession(session, "expired")));
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to close all browser sessions; resources remain tracked for retry");
    }
    if (sessions.length > 0) {
      this.deps.logger.info({ closedSessionCount: sessions.length }, logEvent);
    }
  }

  disposeSession(
    session: BrowserSessionRecord,
    status: "closed" | "expired" | null,
    persistProfile = true
  ): Promise<void> {
    let disposal = this.disposals.get(session);
    if (!disposal) {
      disposal = { status, persistProfile, backendClosed: false, promise: null };
      this.disposals.set(session, disposal);
      this.deps.sessions.beginDisposal(session);
    }
    if (disposal.promise) {
      return disposal.promise;
    }
    const current = disposal;
    current.promise = Promise.resolve().then(() => this.finishDisposal(session, current)).catch((error: unknown) => {
      current.promise = null;
      this.deps.logger.warn({ resourceId: session.resourceId, backend: session.backend.name, error }, "browser_session_close_failed");
      throw error;
    });
    return current.promise;
  }

  private async finishDisposal(session: BrowserSessionRecord, disposal: SessionDisposal): Promise<void> {
    if (!disposal.backendClosed) {
      if (disposal.persistProfile) {
        try {
          await this.profilePersistence.persistSessionProfile(session);
        } catch (error: unknown) {
          this.deps.logger.warn({ resourceId: session.resourceId, profileId: session.profileId, error }, "browser_profile_persist_failed");
        }
      }
      await session.backend.close(session.state);
      disposal.backendClosed = true;
    }
    if (disposal.status === "closed") {
      await this.deps.resourceSync.markClosed(session.resourceId);
    } else if (disposal.status === "expired") {
      await this.deps.resourceSync.markExpired(session.resourceId);
    }
    this.deps.sessions.completeDisposal(session);
  }
}
