import type { AppConfig } from "#config/config.ts";
import type {
  BrowserScreenshotResult,
  DownloadBrowserAssetResult
} from "./types.ts";

type BrowserImportStore = {
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

export class BrowserAssetStore {
  constructor(
    private readonly config: AppConfig,
    private readonly getChatFileStore: () => BrowserImportStore
  ) {}

  async storeScreenshot(input: {
    buffer: Buffer;
    resourceId: string;
    profileId: string | null;
    mode: "page" | "element";
    targetId?: number;
  }): Promise<BrowserScreenshotResult> {
    if (input.buffer.byteLength > this.config.browser.playwright.screenshotMaxBytes) {
      throw new Error(`Screenshot exceeds ${this.config.browser.playwright.screenshotMaxBytes} bytes`);
    }

    const uploaded = await this.getChatFileStore().importBuffer({
      buffer: input.buffer,
      mimeType: "image/png",
      sourceName: input.mode === "page" ? "browser-page.png" : `browser-element-${input.targetId}.png`,
      kind: "image",
      origin: "browser_screenshot",
      sourceContext: {
        resourceId: input.resourceId,
        mode: input.mode,
        ...(input.targetId == null ? {} : { targetId: input.targetId })
      }
    });
    const fileId = uploaded.fileId;
    if (!fileId) {
      throw new Error("Failed to register screenshot image");
    }
    return {
      ok: true,
      resource_id: input.resourceId,
      profile_id: input.profileId,
      fileId,
      mimeType: "image/png",
      sizeBytes: input.buffer.byteLength,
      mode: input.mode,
      target_id: input.targetId ?? null
    };
  }

  async storeDownload(input: {
    sourceUrl: string;
    sourceName?: string;
    kind?: "image" | "animated_image" | "video" | "audio" | "file";
    resourceId?: string | null;
    targetId?: number | null;
  }): Promise<DownloadBrowserAssetResult> {
    const downloaded = await this.getChatFileStore().importRemoteSource({
      source: input.sourceUrl,
      ...(input.sourceName ? { sourceName: input.sourceName } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      origin: "browser_download",
      proxyConsumer: "browser",
      sourceContext: {
        source_url: input.sourceUrl,
        ...(input.resourceId ? { resourceId: input.resourceId } : {}),
        ...(input.targetId != null ? { targetId: input.targetId } : {})
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
      source_url: input.sourceUrl,
      resource_id: input.resourceId ?? null,
      target_id: input.targetId ?? null
    };
  }
}
