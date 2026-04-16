import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { findMatches, normalizeLineNumber, normalizeWaitMs, renderSnapshot, validateHttpUrl } from "./contentExtraction.ts";
import {
  buildInteractionSuccessMessage,
  extractDownloadSourceUrl,
  resolveInteractionTarget,
  validateInteractionInput
} from "./browserInteractionPolicy.ts";
import type { BrowserBackend } from "./types.ts";
import type {
  BrowserPageListResult,
  BrowserScreenshotResult,
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
import { BrowserSessionRuntime, type BrowserSessionRecord } from "./browserSessionRuntime.ts";
import { BrowserResourceSync } from "./browserResourceSync.ts";
import { BrowserAssetStore } from "./browserAssetStore.ts";
import { BrowserProfileService } from "./browserProfileService.ts";
import { BrowserSessionJanitor } from "./browserSessionJanitor.ts";

interface OpenedBrowserSession {
  backend: BrowserBackend;
  state: unknown;
  snapshot: BrowserSessionRecord["snapshot"];
}

export class BrowserPageService {
  constructor(
    private readonly deps: {
      config: AppConfig;
      logger: Logger;
      resolveSearchRef: (refId: string) => string | null;
      playwrightBackend: BrowserBackend;
      sessions: BrowserSessionRuntime;
      resourceSync: BrowserResourceSync;
      assetStore: BrowserAssetStore;
    },
    private readonly profileService: BrowserProfileService,
    private readonly janitor: BrowserSessionJanitor
  ) {}

  async openPage(input: OpenPageInput): Promise<OpenPageResult> {
    if (!this.deps.config.browser.enabled) {
      throw new Error("Browser tools are disabled");
    }
    if (!this.deps.config.browser.playwright.enabled) {
      throw new Error("Playwright browser backend is disabled");
    }
    await this.janitor.cleanupExpiredSessions();

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
    const profile = await this.profileService.resolveProfileForOpen(ownerSessionId);
    const openResult = await this.openWithBackend({
      resolvedUrl: resolvedRequestedUrl,
      requestedUrl: resolvedRequestedUrl,
      profileId: profile.profileId,
      storageState: profile.storageState,
      sessionStorageByOrigin: profile.sessionStorageByOrigin,
      persistState: profile.persistState
    });
    const expiresAt = this.janitor.computeNextExpiry();
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
    await Promise.all(evicted.map((session) => this.janitor.disposeEvictedSession(session)));

    return {
      ok: true,
      ...renderSnapshot(resourceId, openResult.backend.name, openResult.snapshot, line)
    };
  }

  async inspectPage(input: InspectPageInput): Promise<InspectPageResult> {
    await this.janitor.cleanupExpiredSessions();
    const resourceId = String(input.resourceId ?? "").trim();
    const pattern = String(input.pattern ?? "").trim();
    if (!resourceId) {
      throw new Error("resource_id is required");
    }

    const session = await this.janitor.requireSession(resourceId, { touch: true });
    return {
      ok: true,
      ...renderSnapshot(resourceId, session.backend.name, session.snapshot, normalizeLineNumber(input.line)),
      pattern: pattern || null,
      matches: pattern ? findMatches(session.snapshot.lines, pattern) : []
    };
  }

  async interactWithPage(input: InteractWithPageInput): Promise<InteractWithPageResult> {
    await this.janitor.cleanupExpiredSessions();
    const resourceId = String(input.resourceId ?? "").trim();
    if (!resourceId) {
      throw new Error("resource_id is required");
    }

    const session = await this.janitor.requireSession(resourceId, { touch: true });
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
    await this.profileService.persistSessionProfile(session);
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
    await this.janitor.cleanupExpiredSessions();
    const normalizedResourceId = String(resourceId ?? "").trim();
    if (!normalizedResourceId) {
      throw new Error("resource_id is required");
    }

    const session = await this.janitor.requireSession(normalizedResourceId, { touch: false });
    this.deps.sessions.delete(normalizedResourceId);
    await this.profileService.persistSessionProfile(session);
    await session.backend.close(session.state);
    await this.deps.resourceSync.markClosed(normalizedResourceId);
    return {
      ok: true,
      resource_id: normalizedResourceId,
      closed: true
    };
  }

  async listPages(): Promise<BrowserPageListResult> {
    await this.janitor.cleanupExpiredSessions();
    return {
      ok: true,
      pages: await this.deps.resourceSync.listActivePages(this.deps.sessions)
    };
  }

  async downloadAsset(input: DownloadBrowserAssetInput): Promise<DownloadBrowserAssetResult> {
    await this.janitor.cleanupExpiredSessions();
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
      const session = await this.janitor.requireSession(String(resourceId), { touch: true });
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

  private async captureScreenshot(
    resourceId: string,
    mode: "page" | "element",
    targetId?: number
  ): Promise<BrowserScreenshotResult> {
    await this.janitor.cleanupExpiredSessions();
    const session = await this.janitor.requireSession(resourceId, { touch: true });
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
}

function normalizeOptionalString(value: string | undefined): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}
