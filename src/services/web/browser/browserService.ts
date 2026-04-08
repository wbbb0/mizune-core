import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { RuntimeResourceRegistry } from "#runtime/resources/runtimeResourceRegistry.ts";
import type { BrowserPageResourceSummary } from "#runtime/resources/resourceTypes.ts";
import { findMatches, normalizeLineNumber, normalizeWaitMs, renderSnapshot, validateHttpUrl } from "./contentExtraction.ts";
import { BrowserProfileStore } from "./browserProfileStore.ts";
import { PlaywrightBrowserBackend } from "./playwrightBrowserBackend.ts";
import type {
  BrowserActionTarget,
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

interface BrowserSessionRecord {
  resourceId: string;
  runtimePageId: string;
  backend: BrowserBackend;
  state: unknown;
  snapshot: BrowserSnapshot;
  expiresAt: number;
  ownerSessionId: string | null;
  profileId: string | null;
}

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
  private readonly playwrightBackend: BrowserBackend;
  private readonly sessions = new Map<string, BrowserSessionRecord>();
  private nextPageId = 1;
  private readonly resourceRegistry: RuntimeResourceRegistry;
  private readonly profileStore: BrowserProfileStore;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly resolveSearchRef: (refId: string) => string | null,
    dataDir: string,
    private readonly mediaWorkspace: ScreenshotImageStore
  ) {
    this.playwrightBackend = new PlaywrightBrowserBackend(config, logger);
    this.resourceRegistry = new RuntimeResourceRegistry(dataDir, logger);
    this.profileStore = new BrowserProfileStore(dataDir, config, logger);
  }

  async reloadConfig(): Promise<void> {
    await this.closeAllSessions("browser_sessions_closed_after_config_reload");
  }

  async openPage(input: OpenPageInput): Promise<OpenPageResult> {
    if (!this.config.browser.enabled) {
      throw new Error("Browser tools are disabled");
    }
    if (!this.config.browser.playwright.enabled) {
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
      ? this.resolveSearchRef(refId)
      : validateHttpUrl(requestedUrl);
    if (!resolvedRequestedUrl) {
      throw new Error(refId ? `Unknown ref_id: ${refId}` : "url must be an absolute http or https URL");
    }

    const ownerSessionId = normalizeOptionalString(input.ownerSessionId);
    const profile = ownerSessionId && this.config.browser.playwright.persistSessionState
      ? await this.profileStore.ensureProfile(ownerSessionId)
      : null;
    const loadedProfile = profile
      ? await this.profileStore.loadProfile(profile.profileId)
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
    const createdAtMs = Date.now();
    const resource = await this.resourceRegistry.createBrowserPage({
      ownerSessionId,
      title: openResult.snapshot.title,
      description: normalizeOptionalString(input.description),
      summary: summarizeSnapshot(openResult.snapshot),
      createdAtMs,
      expiresAtMs: expiresAt,
      browserPage: {
        requestedUrl: openResult.snapshot.requestedUrl,
        resolvedUrl: openResult.snapshot.resolvedUrl,
        backend: openResult.backend.name,
        title: openResult.snapshot.title,
        profileId: openResult.snapshot.profileId
      }
    });
    this.sessions.set(resource.resourceId, {
      resourceId: resource.resourceId,
      runtimePageId: this.createPageId(),
      backend: openResult.backend,
      state: openResult.state,
      snapshot: openResult.snapshot,
      expiresAt,
      ownerSessionId,
      profileId: openResult.snapshot.profileId
    });
    trimSessions(this.sessions, MAX_BROWSER_SESSIONS);

    return {
      ok: true,
      ...renderSnapshot(resource.resourceId, openResult.backend.name, openResult.snapshot, line)
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
    await this.resourceRegistry.touch(resourceId, {
      accessedAtMs: Date.now(),
      expiresAtMs: session.expiresAt,
      title: session.snapshot.title,
      summary: summarizeSnapshot(session.snapshot),
      status: "active"
    });

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
    this.sessions.delete(normalizedResourceId);
    await this.persistSessionProfile(session);
    await session.backend.close(session.state);
    await this.resourceRegistry.markStatus(normalizedResourceId, "closed", Date.now());
    return {
      ok: true,
      resource_id: normalizedResourceId,
      closed: true
    };
  }

  async listPages(): Promise<BrowserPageListResult> {
    await this.cleanupExpiredSessions();
    const records = await this.resourceRegistry.list("browser_page");
    const pages: BrowserPageResourceSummary[] = [];

    for (const record of records) {
      if (!record.browserPage) {
        continue;
      }
      const activeSession = this.sessions.get(record.resourceId);
      const resolvedStatus = activeSession ? "active" : (record.status === "active" ? "expired" : record.status);
      if (!activeSession && record.status === "active") {
        await this.resourceRegistry.markStatus(record.resourceId, "expired", Date.now());
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

    return {
      ok: true,
      pages
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

    const downloaded = await this.mediaWorkspace.importRemoteSource({
      source: String(sourceUrl),
      ...(sourceName ? { sourceName } : {}),
      ...(kind ? { kind } : {}),
      origin: "browser_download",
      proxyConsumer: "browser",
      sourceContext: {
        source_url: String(sourceUrl),
        ...(resolvedResourceId ? { resourceId: resolvedResourceId } : {}),
        ...(resolvedTargetId != null ? { targetId: resolvedTargetId } : {})
      }
    });

    return {
      ok: true,
      file_id: downloaded.fileId,
      kind: downloaded.kind,
      source_name: downloaded.sourceName,
      mimeType: downloaded.mimeType,
      sizeBytes: downloaded.sizeBytes,
      origin: "browser_download",
      source_url: String(sourceUrl),
      resource_id: resolvedResourceId,
      target_id: resolvedTargetId
    };
  }

  async listProfiles(): Promise<BrowserProfileListResult> {
    return {
      ok: true,
      profiles: await this.profileStore.listProfiles()
    };
  }

  async inspectProfile(profileId: string): Promise<BrowserProfileInspectResult> {
    const profile = await this.profileStore.inspectProfile(profileId);
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

    const liveSession = Array.from(this.sessions.values()).find((item) => item.profileId === normalizedProfileId);
    if (liveSession) {
      await this.persistSessionProfile(liveSession);
    } else {
      const existing = await this.profileStore.inspectProfile(normalizedProfileId);
      if (!existing) {
        throw new Error(`Unknown profile_id: ${profileId}`);
      }
      await this.profileStore.markUsed(normalizedProfileId);
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
    const cleared = await this.profileStore.clearProfile(normalizedProfileId);
    if (!cleared) {
      throw new Error(`Unknown profile_id: ${profileId}`);
    }
    for (const session of this.sessions.values()) {
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
    if (buffer.byteLength > this.config.browser.playwright.screenshotMaxBytes) {
      throw new Error(`Screenshot exceeds ${this.config.browser.playwright.screenshotMaxBytes} bytes`);
    }

    const uploaded = await this.mediaWorkspace.importBuffer({
      buffer,
      mimeType: "image/png",
      sourceName: mode === "page" ? "browser-page.png" : `browser-element-${targetId}.png`,
      kind: "image",
      origin: "browser_screenshot",
      sourceContext: {
        resourceId,
        mode,
        ...(targetId == null ? {} : { targetId })
      }
    });
    const fileId = uploaded.fileId;
    if (!fileId) {
      throw new Error("Failed to register screenshot image");
    }
    return {
      ok: true,
      resource_id: resourceId,
      profile_id: session.profileId,
      fileId,
      mimeType: "image/png",
      sizeBytes: buffer.byteLength,
      mode,
      target_id: targetId ?? null
    };
  }

  private async openWithBackend(input: {
    resolvedUrl: string;
    requestedUrl: string;
    profileId: string | null;
    storageState: unknown | null;
    sessionStorageByOrigin: Record<string, Record<string, string>>;
    persistState: boolean;
  }): Promise<OpenedBrowserSession> {
    const result = await this.playwrightBackend.open({
      url: input.resolvedUrl,
      requestedUrl: input.requestedUrl,
      profileId: input.profileId,
      storageState: input.storageState,
      sessionStorageByOrigin: input.sessionStorageByOrigin,
      persistState: input.persistState
    });
    return {
      backend: this.playwrightBackend,
      state: result.state,
      snapshot: result.snapshot
    };
  }

  private async requireSession(resourceId: string, options?: { touch?: boolean }): Promise<BrowserSessionRecord> {
    const session = this.sessions.get(resourceId);
    if (!session) {
      await this.resourceRegistry.markStatus(resourceId, "expired", Date.now()).catch(() => null);
      throw new Error(`Unknown resource_id: ${resourceId}`);
    }
    if (options?.touch !== false) {
      session.expiresAt = this.computeNextExpiry();
      await this.resourceRegistry.touch(resourceId, {
        accessedAtMs: Date.now(),
        expiresAtMs: session.expiresAt,
        title: session.snapshot.title,
        summary: summarizeSnapshot(session.snapshot),
        status: "active"
      });
    }
    return session;
  }

  private computeNextExpiry(): number {
    return Date.now() + this.config.browser.sessionTtlMs;
  }

  private async cleanupExpiredSessions(): Promise<void> {
    const now = Date.now();
    const expiredSessions = Array.from(this.sessions.values()).filter((session) => session.expiresAt <= now);
    if (expiredSessions.length === 0) {
      return;
    }

    for (const session of expiredSessions) {
      this.sessions.delete(session.resourceId);
      await this.persistSessionProfile(session).catch((error: unknown) => {
        this.logger.warn(
          { profileId: session.profileId, error: error instanceof Error ? error.message : String(error) },
          "browser_profile_persist_failed"
        );
      });
      await session.backend.close(session.state).catch((error: unknown) => {
        this.logger.warn(
          {
            resourceId: session.resourceId,
            backend: session.backend.name,
            error: error instanceof Error ? error.message : String(error)
          },
          "browser_session_close_failed"
        );
      });
      await this.resourceRegistry.markStatus(session.resourceId, "expired", now).catch(() => null);
    }

    this.logger.info({ expiredSessionCount: expiredSessions.length }, "browser_sessions_expired");
  }

  private createPageId(): string {
    const pageId = `page_${this.nextPageId}`;
    this.nextPageId += 1;
    return pageId;
  }

  private async closeAllSessions(logEvent: string): Promise<void> {
    const existingSessions = Array.from(this.sessions.values());
    this.sessions.clear();

    await Promise.all(existingSessions.map(async (session) => {
      try {
        await this.persistSessionProfile(session);
        await session.backend.close(session.state);
      } catch (error: unknown) {
        this.logger.warn(
          {
            resourceId: session.resourceId,
            backend: session.backend.name,
            error: error instanceof Error ? error.message : String(error)
          },
          "browser_session_close_failed"
        );
      }
      await this.resourceRegistry.markStatus(session.resourceId, "expired", Date.now()).catch(() => null);
    }));

    if (existingSessions.length > 0) {
      this.logger.info({ closedSessionCount: existingSessions.length }, logEvent);
    }
  }

  private async persistSessionProfile(session: BrowserSessionRecord): Promise<void> {
    if (!session.profileId || !session.ownerSessionId || !this.config.browser.playwright.persistSessionState) {
      return;
    }
    const persisted = await session.backend.persistState(session.state);
    await this.profileStore.saveProfile({
      profileId: session.profileId,
      ownerSessionId: session.ownerSessionId,
      storageState: persisted.storageState,
      sessionStorageByOrigin: persisted.sessionStorageByOrigin
    });
  }
}

function validateInteractionInput(input: InteractWithPageInput): string | null {
  const hasCoordinate = hasBrowserCoordinate(input.coordinate);
  const hasElementTarget = input.targetId !== undefined || hasSemanticTarget(input.target);
  const hasTarget = hasElementTarget || hasCoordinate;
  const disallowTarget = input.action === "wait"
    || input.action === "scroll_down"
    || input.action === "scroll_up"
    || input.action === "go_back"
    || input.action === "go_forward"
    || input.action === "reload";

  if (disallowTarget && hasTarget) {
    return `action ${input.action} does not accept target_id, target or coordinate`;
  }

  if (hasCoordinate && hasElementTarget) {
    return "coordinate cannot be combined with target_id or target";
  }

  if (hasCoordinate && input.action !== "click" && input.action !== "hover") {
    return `action ${input.action} does not accept coordinate`;
  }

  if (input.action === "press") {
    if (!String(input.key ?? "").trim()) {
      return "press action requires non-empty key";
    }
    return null;
  }

  if (input.action === "type") {
    if (!hasElementTarget) {
      return "type action requires target_id or target";
    }
    if (input.text === undefined) {
      return "type action requires text";
    }
    return null;
  }

  if (input.action === "upload") {
    if (!hasElementTarget) {
      return "upload action requires target_id or target";
    }
    if (!Array.isArray(input.filePaths) || input.filePaths.length === 0) {
      return "upload action requires non-empty file_paths";
    }
    return null;
  }

  if (input.action === "select") {
    if (!hasElementTarget) {
      return "select action requires target_id or target";
    }
    if (!String(input.value ?? input.text ?? "").trim()) {
      return "select action requires value";
    }
    return null;
  }

  if (input.action === "click"
    || input.action === "hover"
    || input.action === "check"
    || input.action === "uncheck"
    || input.action === "submit") {
    return hasTarget ? null : `action ${input.action} requires target_id or target`;
  }

  return null;
}

function hasBrowserCoordinate(
  coordinate: InteractWithPageInput["coordinate"] | undefined
): boolean {
  return Number.isFinite(coordinate?.x) && Number.isFinite(coordinate?.y);
}

function hasSemanticTarget(target: BrowserActionTarget | undefined): boolean {
  if (!target) {
    return false;
  }
  return Boolean(
    target.role
    || target.name
    || target.text
    || target.tag
    || target.type
    || target.hrefContains
    || target.index !== undefined
  );
}

function resolveInteractionTarget(
  elements: readonly BrowserSnapshot["elements"][number][],
  input: InteractWithPageInput
): {
  ok: true;
  targetId: number | undefined;
  resolvedTarget: BrowserSnapshot["elements"][number] | null;
  candidateCount: number;
  candidates: BrowserSnapshot["elements"];
} | {
  ok: false;
  candidateCount: number;
  candidates: BrowserSnapshot["elements"];
  disambiguationRequired: boolean;
  message: string;
} {
  if (input.targetId !== undefined) {
    const resolvedTarget = elements.find((item) => item.id === input.targetId) ?? null;
    if (!resolvedTarget) {
      return {
        ok: false,
        candidateCount: 0,
        candidates: [],
        disambiguationRequired: false,
        message: `未找到 target_id=${input.targetId} 对应的元素，请先重新 inspect_page。`
      };
    }
    if (resolvedTarget.disabled) {
      return {
        ok: false,
        candidateCount: 1,
        candidates: [resolvedTarget],
        disambiguationRequired: false,
        message: `目标元素 #${resolvedTarget.id} 当前不可用（disabled）。`
      };
    }
    return {
      ok: true,
      targetId: resolvedTarget.id,
      resolvedTarget,
      candidateCount: 1,
      candidates: [resolvedTarget]
    };
  }

  if (hasBrowserCoordinate(input.coordinate)) {
    return {
      ok: true,
      targetId: undefined,
      resolvedTarget: null,
      candidateCount: 0,
      candidates: []
    };
  }

  if (!hasSemanticTarget(input.target)) {
    return {
      ok: true,
      targetId: undefined,
      resolvedTarget: null,
      candidateCount: 0,
      candidates: []
    };
  }

  const matches = elements.filter((item) => matchesSemanticTarget(item, input.target!));
  const visibleMatches = matches.filter((item) => !item.disabled && item.visibility === "visible");
  const candidates = (visibleMatches.length > 0 ? visibleMatches : matches).slice(0, 5);
  if (visibleMatches.length === 0) {
    return {
      ok: false,
      candidateCount: matches.length,
      candidates,
      disambiguationRequired: false,
      message: `未找到与目标描述匹配的可操作元素。`
    };
  }

  const requestedIndex = input.target?.index;
  if (requestedIndex !== undefined) {
    const indexed = visibleMatches[requestedIndex - 1];
    if (!indexed) {
      return {
        ok: false,
        candidateCount: visibleMatches.length,
        candidates,
        disambiguationRequired: false,
        message: `目标描述只匹配到 ${visibleMatches.length} 个候选，index=${requestedIndex} 超出范围。`
      };
    }
    return {
      ok: true,
      targetId: indexed.id,
      resolvedTarget: indexed,
      candidateCount: visibleMatches.length,
      candidates
    };
  }

  if (visibleMatches.length > 1) {
    return {
      ok: false,
      candidateCount: visibleMatches.length,
      candidates,
      disambiguationRequired: true,
      message: `目标描述匹配到 ${visibleMatches.length} 个候选，请改用 target.index 或 target_id。`
    };
  }

  const resolvedTarget = visibleMatches[0] ?? null;
  return {
    ok: true,
    targetId: resolvedTarget?.id,
    resolvedTarget,
    candidateCount: visibleMatches.length,
    candidates
  };
}

function matchesSemanticTarget(element: BrowserSnapshot["elements"][number], target: BrowserActionTarget): boolean {
  if (target.role && !stringIncludes(element.role, target.role)) {
    return false;
  }
  if (target.name && !stringIncludes(element.name, target.name)) {
    return false;
  }
  if (target.text && !stringIncludes(element.text, target.text)) {
    return false;
  }
  if (target.tag && !stringIncludes(element.tag, target.tag, { exact: true })) {
    return false;
  }
  if (target.type && !stringIncludes(element.type, target.type, { exact: true })) {
    return false;
  }
  if (target.hrefContains && !stringIncludes(element.href, target.hrefContains)) {
    return false;
  }
  return true;
}

function stringIncludes(
  value: string | null | undefined,
  expected: string,
  options?: { exact?: boolean }
): boolean {
  const normalizedValue = String(value ?? "").trim().toLowerCase();
  const normalizedExpected = String(expected ?? "").trim().toLowerCase();
  if (!normalizedExpected) {
    return true;
  }
  return options?.exact ? normalizedValue === normalizedExpected : normalizedValue.includes(normalizedExpected);
}

function buildInteractionSuccessMessage(action: InteractWithPageInput["action"], target: BrowserSnapshot["elements"][number] | null): string {
  if (!target) {
    return `已执行页面动作：${action}。`;
  }
  const label = target.name || target.text || target.locator_hint || `#${target.id}`;
  return `已对元素 ${label} 执行 ${action}。`;
}

function extractDownloadSourceUrl(element: BrowserSnapshot["elements"][number]): string | null {
  const candidates = [
    element.href,
    element.media_url,
    element.poster_url,
    ...element.source_urls
  ];
  for (const candidate of candidates) {
    const resolved = validateHttpUrl(String(candidate ?? "").trim());
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

function trimSessions(map: Map<string, BrowserSessionRecord>, maxSize: number): void {
  while (map.size > maxSize) {
    const firstKey = map.keys().next().value;
    if (!firstKey) {
      break;
    }
    const session = map.get(firstKey);
    map.delete(firstKey);
    void session?.backend.close(session.state).catch(() => undefined);
  }
}

function summarizeSnapshot(snapshot: BrowserSnapshot): string {
  const title = snapshot.title?.trim();
  if (title) {
    return title;
  }
  const firstLine = snapshot.lines.find((line) => line.trim())?.trim();
  return firstLine ? firstLine.slice(0, 120) : snapshot.resolvedUrl;
}

function normalizeOptionalString(value: string | undefined): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}
