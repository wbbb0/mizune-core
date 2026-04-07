import { readFile } from "node:fs/promises";
import type { Logger } from "pino";
import sharp from "sharp";
import type { AppConfig } from "#config/config.ts";
import type { WorkspaceAssetRecord } from "./types.ts";
import type { MediaWorkspace } from "./mediaWorkspace.ts";

export interface PreparedWorkspaceVisual {
  assetId: string;
  inputUrl: string;
  kind: WorkspaceAssetRecord["kind"];
  transport: "data_url";
  animated: boolean;
  durationMs: number | null;
  sampledFrameCount: number | null;
}

export class MediaVisionService {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly mediaWorkspace: Pick<MediaWorkspace, "getAsset" | "resolveAbsolutePath">
  ) {}

  async prepareAssetsForModel(assetIds: string[]): Promise<PreparedWorkspaceVisual[]> {
    const uniqueIds = Array.from(new Set(assetIds.map((item) => String(item ?? "").trim()).filter(Boolean)));
    const prepared: PreparedWorkspaceVisual[] = [];
    for (const assetId of uniqueIds) {
      prepared.push(await this.prepareAssetForModel(assetId));
    }
    return prepared;
  }

  async prepareAssetForModel(assetId: string): Promise<PreparedWorkspaceVisual> {
    const asset = await this.mediaWorkspace.getAsset(assetId);
    if (!asset) {
      throw new Error(`Workspace asset not found: ${assetId}`);
    }
    if (asset.kind !== "image" && asset.kind !== "animated_image") {
      throw new Error(`Workspace asset is not viewable: ${assetId}`);
    }

    const buffer = await readFile(await this.mediaWorkspace.resolveAbsolutePath(assetId));
    if (asset.kind === "animated_image") {
      return this.prepareAnimatedAsset(asset, buffer);
    }

    return {
      assetId: asset.assetId,
      inputUrl: await this.serializeImage(buffer),
      kind: asset.kind,
      transport: "data_url",
      animated: false,
      durationMs: null,
      sampledFrameCount: null
    };
  }

  private async prepareAnimatedAsset(asset: WorkspaceAssetRecord, buffer: Buffer): Promise<PreparedWorkspaceVisual> {
    const metadata = await sharp(buffer, {
      animated: true,
      failOn: "none"
    }).metadata();
    const pageCount = normalizeAnimatedPageCount(metadata.pages);
    const durationMs = normalizeAnimatedDurationMs(metadata.delay, pageCount);
    const animated = pageCount > 1 && durationMs > 0;
    if (!animated) {
      return {
        assetId: asset.assetId,
        inputUrl: await this.serializeImage(buffer),
        kind: asset.kind,
        transport: "data_url",
        animated: false,
        durationMs: durationMs > 0 ? durationMs : null,
        sampledFrameCount: null
      };
    }

    const frameIndexes = selectAnimatedFrameIndexes(pageCount, durationMs);
    return {
      assetId: asset.assetId,
      inputUrl: await this.serializeAnimatedStoryboard(buffer, metadata, frameIndexes),
      kind: asset.kind,
      transport: "data_url",
      animated: true,
      durationMs,
      sampledFrameCount: frameIndexes.length
    };
  }

  private async serializeImage(buffer: Buffer): Promise<string> {
    const pipeline = sharp(buffer, { failOn: "none" });
    const metadata = await pipeline.metadata();
    const maxPixels = this.config.conversation.images.maxSerializedPixels;
    let working = sharp(buffer, { failOn: "none" }).rotate();

    if (metadata.width && metadata.height) {
      const totalPixels = metadata.width * metadata.height;
      if (totalPixels > maxPixels) {
        const scale = Math.sqrt(maxPixels / totalPixels);
        const width = Math.max(1, Math.floor(metadata.width * scale));
        const height = Math.max(1, Math.floor(metadata.height * scale));
        working = working.resize({
          width,
          height,
          fit: "inside",
          withoutEnlargement: true
        });
      }
    }

    const outputFormat = normalizeSharpFormat(metadata.format);
    const outputBuffer = outputFormat
      ? await working.toFormat(outputFormat).toBuffer()
      : await working.png().toBuffer();
    const mimeType = formatToMimeType(outputFormat ?? "png");
    return `data:${mimeType};base64,${outputBuffer.toString("base64")}`;
  }

  private async serializeAnimatedStoryboard(
    buffer: Buffer,
    metadata: sharp.Metadata,
    frameIndexes: number[]
  ): Promise<string> {
    const baseWidth = Math.max(1, metadata.width ?? 1);
    const baseHeight = Math.max(1, metadata.pageHeight ?? metadata.height ?? 1);
    const frameCount = Math.max(1, frameIndexes.length);
    const maxPixels = this.config.conversation.images.maxSerializedPixels;
    const perFramePixels = Math.max(1, Math.floor(maxPixels / frameCount));
    const scale = Math.min(1, Math.sqrt(perFramePixels / Math.max(1, baseWidth * baseHeight)));
    const frameWidth = Math.max(1, Math.floor(baseWidth * scale));
    const frameHeight = Math.max(1, Math.floor(baseHeight * scale));
    const columns = Math.min(3, frameCount);
    const rows = Math.max(1, Math.ceil(frameCount / columns));

    const composites = await Promise.all(frameIndexes.map(async (frameIndex, index) => {
      const frameBuffer = await sharp(buffer, {
        animated: true,
        page: frameIndex,
        pages: 1,
        failOn: "none"
      })
        .rotate()
        .resize({
          width: frameWidth,
          height: frameHeight,
          fit: "inside",
          withoutEnlargement: true
        })
        .png()
        .toBuffer();
      return {
        input: frameBuffer,
        left: (index % columns) * frameWidth,
        top: Math.floor(index / columns) * frameHeight
      };
    }));

    const storyboard = await sharp({
      create: {
        width: frameWidth * columns,
        height: frameHeight * rows,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 }
      }
    })
      .composite(composites)
      .png()
      .toBuffer();

    return `data:image/png;base64,${storyboard.toString("base64")}`;
  }
}

function normalizeSharpFormat(format: string | undefined): keyof sharp.FormatEnum | null {
  if (!format) {
    return null;
  }
  if (format === "jpg") {
    return "jpeg";
  }
  if (format in sharp.format) {
    return format as keyof sharp.FormatEnum;
  }
  return null;
}

function normalizeAnimatedPageCount(pages: number | undefined): number {
  return Number.isFinite(pages) && Number(pages) > 0
    ? Math.max(1, Math.round(Number(pages)))
    : 1;
}

function normalizeAnimatedDurationMs(delay: number | number[] | undefined, pageCount: number): number {
  if (Array.isArray(delay)) {
    return Math.max(0, Math.round(delay
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0)
      .reduce((sum, value) => sum + value, 0)));
  }
  const normalizedDelay = Number(delay);
  if (Number.isFinite(normalizedDelay) && normalizedDelay > 0) {
    return Math.max(0, Math.round(normalizedDelay * Math.max(1, pageCount)));
  }
  return 0;
}

function selectAnimatedFrameSampleCount(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return 3;
  }
  if (durationMs < 1500) {
    return 3;
  }
  if (durationMs <= 3500) {
    return 4;
  }
  return 5;
}

function selectAnimatedFrameIndexes(frameCount: number, durationMs: number): number[] {
  const normalizedFrameCount = Math.max(1, Math.round(frameCount));
  const targetCount = Math.min(normalizedFrameCount, selectAnimatedFrameSampleCount(durationMs));
  if (targetCount <= 1) {
    return [0];
  }
  const selected = new Set<number>();
  for (let index = 0; index < targetCount; index += 1) {
    const ratio = targetCount === 1 ? 0 : index / (targetCount - 1);
    const frameIndex = Math.min(
      normalizedFrameCount - 1,
      Math.max(0, Math.round(ratio * (normalizedFrameCount - 1)))
    );
    selected.add(frameIndex);
  }
  return Array.from(selected).sort((left, right) => left - right);
}

function formatToMimeType(format: string): string {
  if (format === "jpeg" || format === "jpg") {
    return "image/jpeg";
  }
  if (format === "webp") {
    return "image/webp";
  }
  if (format === "gif") {
    return "image/gif";
  }
  return "image/png";
}
