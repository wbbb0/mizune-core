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

  constructor(
    readonly deps: BrowserServiceDeps
  ) {
    this.profileService = new BrowserProfileService(this.deps);
    this.janitor = new BrowserSessionJanitor(this.deps, this.profileService);
    this.pageService = new BrowserPageService(this.deps, this.profileService, this.janitor);
  }

  async reloadConfig(): Promise<void> {
    await this.janitor.closeAllSessions("browser_sessions_closed_after_config_reload");
  }

  async openPage(input: OpenPageInput): Promise<OpenPageResult> {
    return this.pageService.openPage(input);
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
