import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { BrowserResourceSync } from "./browserResourceSync.ts";
import { BrowserSessionRuntime, type BrowserSessionRecord } from "./browserSessionRuntime.ts";

type BrowserProfilePersistence = {
  persistSessionProfile(session: BrowserSessionRecord): Promise<void>;
};

export class BrowserSessionJanitor {
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
      await this.deps.resourceSync.markMissingAsExpired(resourceId);
      throw new Error(`Unknown resource_id: ${resourceId}`);
    }
    if (options?.touch !== false) {
      const nextExpiry = this.computeNextExpiry();
      const touched = this.deps.sessions.touch(resourceId, nextExpiry);
      if (!touched) {
        await this.deps.resourceSync.markMissingAsExpired(resourceId);
        throw new Error(`Unknown resource_id: ${resourceId}`);
      }
      await this.deps.resourceSync.touchPage(resourceId, touched);
      return touched;
    }
    return session;
  }

  async cleanupExpiredSessions(): Promise<void> {
    const now = Date.now();
    const expiredSessions = this.deps.sessions.collectExpired(now);
    if (expiredSessions.length === 0) {
      return;
    }

    for (const session of expiredSessions) {
      await this.profilePersistence.persistSessionProfile(session).catch((error: unknown) => {
        this.deps.logger.warn(
          { profileId: session.profileId, error: error instanceof Error ? error.message : String(error) },
          "browser_profile_persist_failed"
        );
      });
      await session.backend.close(session.state).catch((error: unknown) => {
        this.deps.logger.warn(
          {
            resourceId: session.resourceId,
            backend: session.backend.name,
            error: error instanceof Error ? error.message : String(error)
          },
          "browser_session_close_failed"
        );
      });
      await this.deps.resourceSync.markExpired(session.resourceId, now);
    }

    this.deps.resourceSync.logExpiredSessions(expiredSessions.length);
  }

  async closeAllSessions(logEvent: string): Promise<void> {
    const existingSessions = this.deps.sessions.clear();

    await Promise.all(existingSessions.map(async (session) => {
      try {
        await this.profilePersistence.persistSessionProfile(session);
        await session.backend.close(session.state);
      } catch (error: unknown) {
        this.deps.logger.warn(
          {
            resourceId: session.resourceId,
            backend: session.backend.name,
            error: error instanceof Error ? error.message : String(error)
          },
          "browser_session_close_failed"
        );
      }
      await this.deps.resourceSync.markExpired(session.resourceId);
    }));

    if (existingSessions.length > 0) {
      this.deps.logger.info({ closedSessionCount: existingSessions.length }, logEvent);
    }
  }

  async disposeEvictedSession(session: BrowserSessionRecord): Promise<void> {
    try {
      await this.profilePersistence.persistSessionProfile(session);
      await session.backend.close(session.state);
    } catch (error: unknown) {
      this.deps.logger.warn(
        {
          resourceId: session.resourceId,
          backend: session.backend.name,
          error: error instanceof Error ? error.message : String(error)
        },
        "browser_session_close_failed"
      );
    }
    await this.deps.resourceSync.markExpired(session.resourceId);
  }
}
