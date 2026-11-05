import { readFile } from "node:fs/promises";
import type { Logger } from "pino";
import sharp from "sharp";
import { serializeImage, normalizeAnimatedPageCount, normalizeAnimatedDurationMs } from "./visualInputSerialization.ts";
import type { AppConfig } from "#config/config.ts";
import { inferSendableFileKind } from "./sendablePath.ts";
import type { ChatFileRecord } from "./types.ts";
import type { ChatFileStore } from "./chatFileStore.ts";
import type { ContentSafetyService } from "#contentSafety/contentSafetyService.ts";

export interface PreparedWorkspaceVisual {
  fileId: string;
  inputUrl: string;
  kind: ChatFileRecord["kind"];
  transport: "data_url";
  animated: boolean;
  durationMs: number | null;
  sampledFrameCount: number | null;
}

export class MediaVisionService {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly chatFileStore: Pick<ChatFileStore, "getFile" | "resolveAbsolutePath">,
    private readonly contentSafetyService?: Pick<ContentSafetyService, "guardChatFileForLlm">
  ) {}

  async prepareFilesForModel(fileIds: string[]): Promise<PreparedWorkspaceVisual[]> {
    const uniqueIds = Array.from(new Set(fileIds.map((item) => String(item ?? "").trim()).filter(Boolean)));
    const prepared: PreparedWorkspaceVisual[] = [];
    for (const fileId of uniqueIds) {
      prepared.push(await this.prepareFileForModel(fileId));
    }
    return prepared;
  }

  async prepareFileForModel(fileId: string): Promise<PreparedWorkspaceVisual> {
    const guard = await this.contentSafetyService?.guardChatFileForLlm(fileId);
    if (guard && guard !== "allow") {
      throw new Error(`媒体已被内容安全屏蔽：${guard.reason}`);
    }
    const file = await this.chatFileStore.getFile(fileId);
    if (!file) {
      throw new Error(`Workspace file not found: ${fileId}`);
    }
    if (file.kind !== "image" && file.kind !== "animated_image") {
      throw new Error(`Workspace file is not viewable: ${fileId}`);
    }

    const buffer = await readFile(await this.chatFileStore.resolveAbsolutePath(fileId));
    if (file.kind === "animated_image") {
      return this.prepareAnimatedFile(file, buffer);
    }

    return {
      fileId: file.fileId,
      inputUrl: await serializeImage(buffer, this.config.conversation.images.maxSerializedPixels),
      kind: file.kind,
      transport: "data_url",
      animated: false,
      durationMs: null,
      sampledFrameCount: null
    };
  }

  async prepareAbsolutePathForModel(absolutePath: string, sourceName: string): Promise<PreparedWorkspaceVisual> {
    const kind = inferSendableFileKind(absolutePath);
    if (kind === "file") {
      throw new Error(`路径对应的文件不是可查看的媒体格式：${sourceName}`);
    }
    const buffer = await readFile(absolutePath);
    if (kind === "animated_image") {
      return this.prepareAnimatedFile({ fileId: absolutePath, kind } as ChatFileRecord, buffer);
    }
    return {
      fileId: absolutePath,
      inputUrl: await serializeImage(buffer, this.config.conversation.images.maxSerializedPixels),
      kind,
      transport: "data_url",
      animated: false,
      durationMs: null,
      sampledFrameCount: null
    };
  }

  private async prepareAnimatedFile(file: ChatFileRecord, buffer: Buffer): Promise<PreparedWorkspaceVisual> {
    const metadata = await sharp(buffer, {
      animated: true,
      failOn: "none"
    }).metadata();
    const pageCount = normalizeAnimatedPageCount(metadata.pages);
    const durationMs = normalizeAnimatedDurationMs(metadata.delay, pageCount);
    const animated = pageCount > 1 && durationMs > 0;
    if (!animated) {
      return {
        fileId: file.fileId,
        inputUrl: await serializeImage(buffer, this.config.conversation.images.maxSerializedPixels),
        kind: file.kind,
        transport: "data_url",
        animated: false,
        durationMs: durationMs > 0 ? durationMs : null,
        sampledFrameCount: null
      };
    }

    return {
      fileId: file.fileId,
      // 保留原始时序；实际供应商选定后再投影为视频或抽帧拼图。
      inputUrl: `data:image/${metadata.format};base64,${buffer.toString("base64")}`,
      kind: file.kind,
      transport: "data_url",
      animated: true,
      durationMs,
      sampledFrameCount: null
    };
  }
}
