import type { Logger } from "pino";
import { RuntimeResourceRegistry } from "#runtime/resources/runtimeResourceRegistry.ts";
import type { BrowserPageResourceSummary } from "#runtime/resources/resourceTypes.ts";
import type { BrowserSessionRecord, BrowserSessionRuntime } from "./browserSessionRuntime.ts";
import type { BrowserSnapshot } from "./types.ts";

export class BrowserResourceSync {
  constructor(
    private readonly resourceRegistry: RuntimeResourceRegistry,
    private readonly logger: Logger
  ) {}

  async registerOpenedPage(input: {
    ownerSessionId: string | null;
    description: string | null;
    session: BrowserSessionRecord;
  }): Promise<string> {
    const createdAtMs = Date.now();
    const resource = await this.resourceRegistry.createBrowserPage({
      ownerSessionId: input.ownerSessionId,
      title: input.session.snapshot.title,
      description: input.description,
      summary: summarizeSnapshot(input.session.snapshot),
      createdAtMs,
      expiresAtMs: input.session.expiresAt,
      browserPage: {
        requestedUrl: input.session.snapshot.requestedUrl,
        resolvedUrl: input.session.snapshot.resolvedUrl,
        backend: input.session.backend.name,
        title: input.session.snapshot.title,
        profileId: input.session.snapshot.profileId
      }
    });
    return resource.resourceId;
  }

  async touchPage(resourceId: string, session: BrowserSessionRecord): Promise<void> {
    await this.resourceRegistry.touch(resourceId, {
      accessedAtMs: Date.now(),
      expiresAtMs: session.expiresAt,
      title: session.snapshot.title,
      summary: summarizeSnapshot(session.snapshot),
      status: "active"
    });
  }

  async markClosed(resourceId: string): Promise<void> {
    await this.resourceRegistry.markStatus(resourceId, "closed", Date.now());
  }

  async markExpired(resourceId: string, now = Date.now()): Promise<void> {
    await this.resourceRegistry.markStatus(resourceId, "expired", now).catch(() => null);
  }

  async markMissingAsExpired(resourceId: string, now = Date.now()): Promise<void> {
    await this.resourceRegistry.markStatus(resourceId, "expired", now).catch(() => null);
  }

  async listActivePages(sessions: BrowserSessionRuntime): Promise<BrowserPageResourceSummary[]> {
    const records = await this.resourceRegistry.list("browser_page");
    const pages: BrowserPageResourceSummary[] = [];

    for (const record of records) {
      if (!record.browserPage) {
        continue;
      }
      const activeSession = sessions.get(record.resourceId);
      const resolvedStatus = activeSession ? "active" : (record.status === "active" ? "expired" : record.status);
      if (!activeSession && record.status === "active") {
        await this.markExpired(record.resourceId);
      }
      if (!activeSession || resolvedStatus !== "active") {
        continue;
      }
      pages.push({
        resource_id: record.resourceId,
        status: resolvedStatus,
        title: record.title,
        description: record.description,
        summary: record.summary,
        requestedUrl: record.browserPage.requestedUrl,
        resolvedUrl: record.browserPage.resolvedUrl,
        backend: record.browserPage.backend,
        profile_id: record.browserPage.profileId,
        createdAtMs: record.createdAtMs,
        lastAccessedAtMs: record.lastAccessedAtMs,
        expiresAtMs: activeSession.expiresAt
      });
    }

    return pages;
  }

  logExpiredSessions(expiredSessionCount: number): void {
    if (expiredSessionCount > 0) {
      this.logger.info({ expiredSessionCount }, "browser_sessions_expired");
    }
  }
}

export function summarizeSnapshot(snapshot: BrowserSnapshot): string {
  const title = snapshot.title?.trim();
  if (title) {
    return title;
  }
  const firstLine = snapshot.lines.find((line) => line.trim())?.trim();
  return firstLine ? firstLine.slice(0, 120) : snapshot.resolvedUrl;
}
