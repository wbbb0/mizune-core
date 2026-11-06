import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { RuntimeResourceRegistry } from "#runtime/resources/runtimeResourceRegistry.ts";
import { BrowserProfileStore } from "./browserProfileStore.ts";
import { PlaywrightBrowserBackend } from "./playwrightBrowserBackend.ts";
import { BrowserSessionRuntime } from "./browserSessionRuntime.ts";
import { BrowserAssetStore } from "./browserAssetStore.ts";
import { BrowserResourceSync } from "./browserResourceSync.ts";
import { BrowserPageService } from "./browserPageService.ts";
import { BrowserProfileService } from "./browserProfileService.ts";
import { BrowserSessionJanitor } from "./browserSessionJanitor.ts";
import type {
  BrowserBackend,
  BrowserPageListResult,
  BrowserProfileInspectResult,
  BrowserProfileListResult,
  BrowserProfileMutationResult,
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

const MAX_BROWSER_SESSIONS = 256;

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
  private readonly profileService: BrowserProfileService;
  private readonly janitor: BrowserSessionJanitor;
  private readonly pageService: BrowserPageService;
  private readonly openingPages = new Set<Promise<OpenPageResult>>();
  private closingSessions: Promise<void> | null = null;
  private stopped = false;

  constructor(
    readonly deps: BrowserServiceDeps
  ) {
    this.profileService = new BrowserProfileService(this.deps);
    this.janitor = new BrowserSessionJanitor(this.deps, this.profileService);
    this.pageService = new BrowserPageService(this.deps, this.profileService, this.janitor);
  }

  async reloadConfig(): Promise<void> {
    await this.closeSessions("browser_sessions_closed_after_config_reload");
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    await this.closeSessions("browser_sessions_closed_on_runtime_shutdown");
  }

  async openPage(input: OpenPageInput): Promise<OpenPageResult> {
    if (this.stopped || this.closingSessions) {
      throw new Error("Browser service is shutting down or reloading");
    }
    const opening = this.pageService.openPage(input);
    this.openingPages.add(opening);
    try {
      return await opening;
    } finally {
      this.openingPages.delete(opening);
    }
  }

  private closeSessions(logEvent: string): Promise<void> {
    if (!this.closingSessions) {
      this.closingSessions = this.finishClosingSessions(logEvent).finally(() => {
        this.closingSessions = null;
      });
    }
    return this.closingSessions;
  }

  private async finishClosingSessions(logEvent: string): Promise<void> {
    await Promise.allSettled(this.openingPages);
    const results = await Promise.allSettled([
      this.janitor.closeAllSessions(logEvent),
      this.deps.playwrightBackend.cleanupFailedOpens()
    ]);
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length > 0) {
      throw new AggregateError(errors, "Browser cleanup failed; resources remain tracked for retry");
    }
  }

  async inspectPage(input: InspectPageInput): Promise<InspectPageResult> {
    return this.pageService.inspectPage(input);
  }

  async interactWithPage(input: InteractWithPageInput): Promise<InteractWithPageResult> {
    return this.pageService.interactWithPage(input);
  }

  async capturePageScreenshot(resourceId: string): Promise<BrowserScreenshotResult> {
    return this.pageService.capturePageScreenshot(resourceId);
  }

  async captureElementScreenshot(resourceId: string, targetId: number): Promise<BrowserScreenshotResult> {
    return this.pageService.captureElementScreenshot(resourceId, targetId);
  }

  async closePage(resourceId: string): Promise<ClosePageResult> {
    return this.pageService.closePage(resourceId);
  }

  async listPages(): Promise<BrowserPageListResult> {
    return this.pageService.listPages();
  }

  async downloadAsset(input: DownloadBrowserAssetInput): Promise<DownloadBrowserAssetResult> {
    return this.pageService.downloadAsset(input);
  }

  async resolveDownloadAssetSource(input: DownloadBrowserAssetInput) {
    return this.pageService.resolveDownloadAssetSource(input);
  }

  async listProfiles(): Promise<BrowserProfileListResult> {
    return this.profileService.listProfiles();
  }

  async inspectProfile(profileId: string): Promise<BrowserProfileInspectResult> {
    return this.profileService.inspectProfile(profileId);
  }

  async saveProfile(profileId: string): Promise<BrowserProfileMutationResult> {
    return this.profileService.saveProfile(profileId);
  }

  async clearProfile(profileId: string): Promise<BrowserProfileMutationResult> {
    return this.profileService.clearProfile(profileId);
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
  resourceRegistry: RuntimeResourceRegistry;
}): BrowserServiceDeps {
  return {
    config: input.config,
    logger: input.logger,
    resolveSearchRef: input.resolveSearchRef,
    playwrightBackend: new PlaywrightBrowserBackend(input.config, input.logger),
    sessions: new BrowserSessionRuntime(MAX_BROWSER_SESSIONS),
    profileStore: new BrowserProfileStore(input.dataDir, input.config, input.logger),
    resourceSync: new BrowserResourceSync(input.resourceRegistry, input.logger),
    assetStore: new BrowserAssetStore(input.config, () => input.chatFileStore)
  };
}
