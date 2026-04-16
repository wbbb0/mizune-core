import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { RuntimeResourceRegistry } from "#runtime/resources/runtimeResourceRegistry.ts";
import { findMatches, normalizeLineNumber, normalizeWaitMs, renderSnapshot, validateHttpUrl } from "./contentExtraction.ts";
import { BrowserProfileStore } from "./browserProfileStore.ts";
import { PlaywrightBrowserBackend } from "./playwrightBrowserBackend.ts";
import { BrowserSessionRuntime, type BrowserSessionRecord } from "./browserSessionRuntime.ts";
import { BrowserAssetStore } from "./browserAssetStore.ts";
import { BrowserResourceSync } from "./browserResourceSync.ts";
import {
  buildInteractionSuccessMessage,
  extractDownloadSourceUrl,
  resolveInteractionTarget,
  validateInteractionInput
} from "./browserInteractionPolicy.ts";
import type {
  BrowserBackend,
  BrowserPageListResult,
  BrowserProfileInspectResult,
  BrowserProfileListResult,
  BrowserProfileMutationResult,
  BrowserScreenshotResult,
  BrowserSnapshot,
  ClosePageResult,
  DownloadBrowserAssetInput,
  DownloadBrowserAssetResult,
  InspectPageInput,
  InspectPageResult,
  InteractWithPageInput,
  InteractWithPageResult,
  OpenPageInput,
  OpenPageResult
} from "./types.ts";

const MAX_BROWSER_SESSIONS = 256;

interface OpenedBrowserSession {
  backend: BrowserBackend;
  state: unknown;
  snapshot: BrowserSnapshot;
}

type ScreenshotImageStore = {
  importBuffer(input: {
    buffer: Buffer;
    sourceName?: string;
    mimeType?: string;
    kind: "image";
    origin: "browser_screenshot";
    sourceContext?: Record<string, string | number | boolean | null>;
  }): Promise<{ fileId: string }>;
  importRemoteSource(input: {
    source: string;
    sourceName?: string;
    mimeType?: string;
    kind?: "image" | "animated_image" | "video" | "audio" | "file";
    origin: "browser_download";
    proxyConsumer?: "browser";
    sourceContext?: Record<string, string | number | boolean | null>;
  }): Promise<{
    fileId: string;
    kind: "image" | "animated_image" | "video" | "audio" | "file";
    sourceName: string;
    mimeType: string;
    sizeBytes: number;
  }>;
};

export class BrowserService {
  constructor(
    private readonly deps: BrowserServiceDeps
  ) {}

  async reloadConfig(): Promise<void> {
    await this.closeAllSessions("browser_sessions_closed_after_config_reload");
  }

  async openPage(input: OpenPageInput): Promise<OpenPageResult> {
    if (!this.deps.config.browser.enabled) {
      throw new Error("Browser tools are disabled");
    }
    if (!this.deps.config.browser.playwright.enabled) {
      throw new Error("Playwright browser backend is disabled");
    }
    await this.cleanupExpiredSessions();

    const refId = String(input.refId ?? "").trim();
    const requestedUrl = String(input.url ?? "").trim();
    const line = normalizeLineNumber(input.line);
    if (Boolean(refId) === Boolean(requestedUrl)) {
      throw new Error("Provide exactly one of ref_id or url");
    }

    const resolvedRequestedUrl = refId
      ? this.deps.resolveSearchRef(refId)
      : validateHttpUrl(requestedUrl);
    if (!resolvedRequestedUrl) {
      throw new Error(refId ? `Unknown ref_id: ${refId}` : "url must be an absolute http or https URL");
    }

    const ownerSessionId = normalizeOptionalString(input.ownerSessionId);
    const profile = ownerSessionId && this.deps.config.browser.playwright.persistSessionState
      ? await this.deps.profileStore.ensureProfile(ownerSessionId)
      : null;
    const loadedProfile = profile
      ? await this.deps.profileStore.loadProfile(profile.profileId)
      : null;

    const openResult = await this.openWithBackend({
      resolvedUrl: resolvedRequestedUrl,
      requestedUrl: resolvedRequestedUrl,
      profileId: loadedProfile?.profileId ?? profile?.profileId ?? null,
      storageState: loadedProfile?.storageState ?? null,
      sessionStorageByOrigin: loadedProfile?.sessionStorageByOrigin ?? {},
      persistState: Boolean(profile)
    });
    const expiresAt = this.computeNextExpiry();
    const sessionRecord: BrowserSessionRecord = {
      resourceId: "",
      backend: openResult.backend,
      state: openResult.state,
      snapshot: openResult.snapshot,
      expiresAt,
      ownerSessionId,
      profileId: openResult.snapshot.profileId
    };
    const resourceId = await this.deps.resourceSync.registerOpenedPage({
      ownerSessionId,
      description: normalizeOptionalString(input.description),
      session: sessionRecord
    });
    const evicted = this.deps.sessions.set(resourceId, {
      backend: openResult.backend,
      state: openResult.state,
      snapshot: openResult.snapshot,
      expiresAt,
      ownerSessionId,
      profileId: openResult.snapshot.profileId
    });
    await Promise.all(evicted.map((session) => this.disposeEvictedSession(session)));

    return {
      ok: true,
      ...renderSnapshot(resourceId, openResult.backend.name, openResult.snapshot, line)
    };
  }

  async inspectPage(input: InspectPageInput): Promise<InspectPageResult> {
    await this.cleanupExpiredSessions();
    const resourceId = String(input.resourceId ?? "").trim();
    const pattern = String(input.pattern ?? "").trim();
    if (!resourceId) {
      throw new Error("resource_id is required");
    }

    const session = await this.requireSession(resourceId, { touch: true });
    return {
      ok: true,
      ...renderSnapshot(resourceId, session.backend.name, session.snapshot, normalizeLineNumber(input.line)),
      pattern: pattern || null,
      matches: pattern ? findMatches(session.snapshot.lines, pattern) : []
    };
  }

  async interactWithPage(input: InteractWithPageInput): Promise<InteractWithPageResult> {
    await this.cleanupExpiredSessions();
    const resourceId = String(input.resourceId ?? "").trim();
    if (!resourceId) {
      throw new Error("resource_id is required");
    }

    const session = await this.requireSession(resourceId, { touch: true });
    const validationError = validateInteractionInput(input);
    if (validationError) {
      throw new Error(validationError);
    }

    const targetResolution = resolveInteractionTarget(session.snapshot.elements, input);
    if (!targetResolution.ok) {
      return {
        ok: false,
        resource_id: resourceId,
        action: input.action,
        snapshot: {
          ok: true,
          ...renderSnapshot(resourceId, session.backend.name, session.snapshot, normalizeLineNumber(input.line)),
          pattern: null,
          matches: []
        },
        resolved_target: null,
        candidate_count: targetResolution.candidateCount,
        disambiguation_required: targetResolution.disambiguationRequired,
        candidates: targetResolution.candidates,
        message: targetResolution.message
      };
    }

    const next = await session.backend.interact({
      state: session.state,
      snapshot: session.snapshot,
      action: input.action,
      targetId: targetResolution.targetId,
      target: input.target,
      coordinate: input.coordinate,
      text: input.text,
      value: input.value,
      key: input.key,
      filePaths: input.filePaths,
      waitMs: normalizeWaitMs(input.waitMs)
    });
    session.state = next.state;
    session.snapshot = next.snapshot;
    await this.persistSessionProfile(session);
    await this.deps.resourceSync.touchPage(resourceId, session);

    return {
      ok: true,
      resource_id: resourceId,
      action: input.action,
      snapshot: {
        ok: true,
        ...renderSnapshot(resourceId, session.backend.name, session.snapshot, normalizeLineNumber(input.line)),
        pattern: null,
        matches: []
      },
      resolved_target: next.interaction?.resolvedTarget ?? targetResolution.resolvedTarget ?? null,
      candidate_count: targetResolution.candidateCount,
      disambiguation_required: false,
      candidates: targetResolution.candidates,
      message: next.interaction?.message ?? buildInteractionSuccessMessage(input.action, next.interaction?.resolvedTarget ?? targetResolution.resolvedTarget ?? null)
    };
  }

  async capturePageScreenshot(resourceId: string): Promise<BrowserScreenshotResult> {
    return this.captureScreenshot(resourceId, "page");
  }

  async captureElementScreenshot(resourceId: string, targetId: number): Promise<BrowserScreenshotResult> {
    if (!Number.isInteger(targetId) || targetId <= 0) {
      throw new Error("target_id must be a positive integer");
    }
    return this.captureScreenshot(resourceId, "element", targetId);
  }

  async closePage(resourceId: string): Promise<ClosePageResult> {
    await this.cleanupExpiredSessions();
    const normalizedResourceId = String(resourceId ?? "").trim();
    if (!normalizedResourceId) {
      throw new Error("resource_id is required");
    }

    const session = await this.requireSession(normalizedResourceId, { touch: false });
    this.deps.sessions.delete(normalizedResourceId);
    await this.persistSessionProfile(session);
    await session.backend.close(session.state);
    await this.deps.resourceSync.markClosed(normalizedResourceId);
    return {
      ok: true,
      resource_id: normalizedResourceId,
      closed: true
    };
  }

  async listPages(): Promise<BrowserPageListResult> {
    await this.cleanupExpiredSessions();
    return {
      ok: true,
      pages: await this.deps.resourceSync.listActivePages(this.deps.sessions)
    };
  }

  async downloadAsset(input: DownloadBrowserAssetInput): Promise<DownloadBrowserAssetResult> {
    await this.cleanupExpiredSessions();
    const directUrl = normalizeOptionalString(input.url);
    const resourceId = normalizeOptionalString(input.resourceId);
    const sourceName = normalizeOptionalString(input.sourceName) ?? undefined;
    const kind = input.kind;

    if (Boolean(directUrl) === Boolean(resourceId)) {
      throw new Error("Provide exactly one of url or resource_id");
    }

    let sourceUrl: string | null = null;
    let resolvedResourceId: string | null = null;
    let resolvedTargetId: number | null = null;

    if (directUrl) {
      sourceUrl = validateHttpUrl(directUrl);
      if (!sourceUrl) {
        throw new Error("url must be an absolute http or https URL");
      }
    } else {
      const session = await this.requireSession(String(resourceId), { touch: true });
      resolvedResourceId = String(resourceId);
      if (input.targetId != null) {
        const targetId = Number(input.targetId);
        if (!Number.isInteger(targetId) || targetId <= 0) {
          throw new Error("target_id must be a positive integer");
        }
        const element = session.snapshot.elements.find((item) => item.id === targetId) ?? null;
        if (!element) {
          throw new Error(`未找到 target_id=${targetId} 对应的元素`);
        }
        sourceUrl = extractDownloadSourceUrl(element);
        if (!sourceUrl) {
          throw new Error(`元素 #${targetId} 不包含可下载的 href、src、poster 或 source URL`);
        }
        resolvedTargetId = targetId;
      } else {
        sourceUrl = validateHttpUrl(session.snapshot.resolvedUrl);
        if (!sourceUrl) {
          throw new Error("当前页面 resolvedUrl 不是可下载的 http/https URL");
        }
      }
    }

    return this.deps.assetStore.storeDownload({
      sourceUrl: String(sourceUrl),
      ...(sourceName ? { sourceName } : {}),
      ...(kind ? { kind } : {}),
      ...(resolvedResourceId ? { resourceId: resolvedResourceId } : {}),
      ...(resolvedTargetId != null ? { targetId: resolvedTargetId } : {})
    });
  }

  async listProfiles(): Promise<BrowserProfileListResult> {
    return {
      ok: true,
      profiles: await this.deps.profileStore.listProfiles()
    };
  }

  async inspectProfile(profileId: string): Promise<BrowserProfileInspectResult> {
    const profile = await this.deps.profileStore.inspectProfile(profileId);
    if (!profile) {
      throw new Error(`Unknown profile_id: ${profileId}`);
    }
    return {
      ok: true,
      profile
    };
  }

  async saveProfile(profileId: string): Promise<BrowserProfileMutationResult> {
    const normalizedProfileId = String(profileId ?? "").trim();
    if (!normalizedProfileId) {
      throw new Error("profile_id is required");
    }

    const liveSession = this.deps.sessions.findByProfileId(normalizedProfileId);
    if (liveSession) {
      await this.persistSessionProfile(liveSession);
    } else {
      const existing = await this.deps.profileStore.inspectProfile(normalizedProfileId);
      if (!existing) {
        throw new Error(`Unknown profile_id: ${profileId}`);
      }
      await this.deps.profileStore.markUsed(normalizedProfileId);
    }

    return {
      ok: true,
      profile_id: normalizedProfileId,
      saved: true
    };
  }

  async clearProfile(profileId: string): Promise<BrowserProfileMutationResult> {
    const normalizedProfileId = String(profileId ?? "").trim();
    if (!normalizedProfileId) {
      throw new Error("profile_id is required");
    }
    const cleared = await this.deps.profileStore.clearProfile(normalizedProfileId);
    if (!cleared) {
      throw new Error(`Unknown profile_id: ${profileId}`);
    }
    for (const session of this.deps.sessions.values()) {
      if (session.profileId === normalizedProfileId) {
        session.profileId = null;
      }
    }
    return {
      ok: true,
      profile_id: normalizedProfileId,
      cleared: true
    };
  }

  private async captureScreenshot(
    resourceId: string,
    mode: "page" | "element",
    targetId?: number
  ): Promise<BrowserScreenshotResult> {
    await this.cleanupExpiredSessions();
    const session = await this.requireSession(resourceId, { touch: true });
    const buffer = await session.backend.captureScreenshot({
      state: session.state,
      ...(targetId == null ? {} : { targetId })
    });
    return this.deps.assetStore.storeScreenshot({
      buffer,
      resourceId,
      profileId: session.profileId,
      mode,
      ...(targetId == null ? {} : { targetId })
    });
  }

  private async openWithBackend(input: {
    resolvedUrl: string;
    requestedUrl: string;
    profileId: string | null;
    storageState: unknown | null;
    sessionStorageByOrigin: Record<string, Record<string, string>>;
    persistState: boolean;
  }): Promise<OpenedBrowserSession> {
    const result = await this.deps.playwrightBackend.open({
      url: input.resolvedUrl,
      requestedUrl: input.requestedUrl,
      profileId: input.profileId,
      storageState: input.storageState,
      sessionStorageByOrigin: input.sessionStorageByOrigin,
      persistState: input.persistState
    });
    return {
      backend: this.deps.playwrightBackend,
      state: result.state,
      snapshot: result.snapshot
    };
  }

  private async requireSession(resourceId: string, options?: { touch?: boolean }): Promise<BrowserSessionRecord> {
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
    }
    return session;
  }

  private computeNextExpiry(): number {
    return Date.now() + this.deps.config.browser.sessionTtlMs;
  }

  private async cleanupExpiredSessions(): Promise<void> {
    const now = Date.now();
    const expiredSessions = this.deps.sessions.collectExpired(now);
    if (expiredSessions.length === 0) {
      return;
    }

    for (const session of expiredSessions) {
      await this.persistSessionProfile(session).catch((error: unknown) => {
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

  private async closeAllSessions(logEvent: string): Promise<void> {
    const existingSessions = this.deps.sessions.clear();

    await Promise.all(existingSessions.map(async (session) => {
      try {
        await this.persistSessionProfile(session);
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

  private async persistSessionProfile(session: BrowserSessionRecord): Promise<void> {
    if (!session.profileId || !session.ownerSessionId || !this.deps.config.browser.playwright.persistSessionState) {
      return;
    }
    const persisted = await session.backend.persistState(session.state);
    await this.deps.profileStore.saveProfile({
      profileId: session.profileId,
      ownerSessionId: session.ownerSessionId,
      storageState: persisted.storageState,
      sessionStorageByOrigin: persisted.sessionStorageByOrigin
    });
  }

  private async disposeEvictedSession(session: BrowserSessionRecord): Promise<void> {
    try {
      await this.persistSessionProfile(session);
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

export interface BrowserServiceDeps {
  config: AppConfig;
  logger: Logger;
  resolveSearchRef: (refId: string) => string | null;
  playwrightBackend: BrowserBackend;
  sessions: BrowserSessionRuntime;
  profileStore: BrowserProfileStore;
  resourceSync: BrowserResourceSync;
  assetStore: BrowserAssetStore;
}

export function createBrowserServiceDeps(input: {
  config: AppConfig;
  logger: Logger;
  resolveSearchRef: (refId: string) => string | null;
  dataDir: string;
  chatFileStore: ScreenshotImageStore;
}): BrowserServiceDeps {
  const resourceRegistry = new RuntimeResourceRegistry(input.dataDir, input.logger);
  return {
    config: input.config,
    logger: input.logger,
    resolveSearchRef: input.resolveSearchRef,
    playwrightBackend: new PlaywrightBrowserBackend(input.config, input.logger),
    sessions: new BrowserSessionRuntime(MAX_BROWSER_SESSIONS),
    profileStore: new BrowserProfileStore(input.dataDir, input.config, input.logger),
    resourceSync: new BrowserResourceSync(resourceRegistry, input.logger),
    assetStore: new BrowserAssetStore(input.config, () => input.chatFileStore)
  };
}

function normalizeOptionalString(value: string | undefined): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}
