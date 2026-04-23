import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { normalizeModelRefs } from "#llm/shared/modelProfiles.ts";
import { getModelRefsForRole } from "#llm/shared/modelRouting.ts";
import type { LlmClient, LlmMessage } from "#llm/llmClient.ts";
import type { ChatFileStore } from "./chatFileStore.ts";
import type { MediaVisionService } from "./mediaVisionService.ts";
import type { ChatFileRecord } from "./types.ts";

function buildCaptionPrompt(): LlmMessage[] {
  return [
    {
      role: "system",
      content: [
        "你是图片描述生成器，只负责为聊天里的单张图片生成一句简短但信息足够的中文描述。",
        "优先描述主体、动作、场景、构图、穿着或外观、明显可见文字等可直接看见的信息，不要脑补看不见的细节。",
        "如果画面含明显成人裸露、性暗示或其他 NSFW 内容，必须在开头加“NSFW ”，再用克制、中性、不露骨的中文描述可见内容。",
        "输出一行中文，不要加引号、编号或额外解释，尽量控制在 14 到 36 个字。"
      ].join("\n")
    }
  ];
}

function normalizeCaption(raw: string, fallbackLabel: string): string {
  const singleLine = raw.replace(/\s+/g, " ").replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  if (!singleLine) {
    return fallbackLabel;
  }
  const nsfwMatch = singleLine.match(/^(?:nsfw|r18|成人|色情|裸露|敏感)\s*[:：\- ]*\s*(.*)$/i);
  const isNsfw = Boolean(nsfwMatch);
  const body = (nsfwMatch?.[1] ?? singleLine).trim();
  const normalized = body || fallbackLabel;
  const maxLength = isNsfw ? 40 : 36;
  const clipped = normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength);
  return isNsfw ? `NSFW ${clipped}` : clipped;
}

export class MediaCaptionService {
  private readonly queued = new Set<string>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly pending: string[] = [];

  constructor(
    private readonly config: AppConfig,
    private readonly llmClient: LlmClient,
    private readonly chatFileStore: Pick<ChatFileStore, "getFile" | "getMany" | "updateCaption">,
    private readonly mediaVisionService: Pick<MediaVisionService, "prepareFileForModel">,
    private readonly logger: Logger
  ) {}

  isEnabled(): boolean {
    const modelRefs = this.resolveModelRefs();
    return this.config.llm.enabled
      && this.config.llm.imageCaptioner.enabled
      && modelRefs.length > 0
      && this.llmClient.isConfigured(modelRefs);
  }

  async getCaptionMap(fileIds: string[]): Promise<Map<string, string>> {
    const files = await this.chatFileStore.getMany(uniqueIds(fileIds));
    return new Map(
      files
        .filter((item) => typeof item.caption === "string" && item.caption.length > 0)
        .map((item) => [item.fileId, item.caption as string])
    );
  }

  schedule(fileIds: string[], reason: string): void {
    if (!this.isEnabled()) {
      return;
    }
    void this.enqueue(uniqueIds(fileIds), reason);
  }

  async ensureReady(fileIds: string[], options?: { reason?: string; abortSignal?: AbortSignal }): Promise<Map<string, string>> {
    const ids = uniqueIds(fileIds);
    if (ids.length === 0) {
      return new Map();
    }
    if (!this.isEnabled()) {
      return this.getCaptionMap(ids);
    }
    await this.enqueue(ids, options?.reason ?? "ensure_ready");
    await Promise.all(ids.map((fileId) => this.waitForCompletion(fileId, options?.abortSignal)));
    return this.getCaptionMap(ids);
  }

  private async enqueue(fileIds: string[], reason: string): Promise<void> {
    const existing = await this.chatFileStore.getMany(fileIds);
    const pendingIds = existing
      .filter(isCaptionableFile)
      .filter((item) => !item.caption)
      .map((item) => item.fileId);
    if (pendingIds.length === 0) {
      return;
    }
    for (const fileId of pendingIds) {
      if (this.queued.has(fileId) || this.running.has(fileId)) {
        continue;
      }
      this.queued.add(fileId);
      this.pending.push(fileId);
    }
    this.logger.debug({ fileCount: pendingIds.length, reason }, "media_caption_enqueued");
    this.pump();
  }

  private pump(): void {
    const maxConcurrency = this.config.llm.imageCaptioner.maxConcurrency;
    while (this.running.size < maxConcurrency) {
      const nextFileId = this.pending.shift();
      if (!nextFileId) {
        return;
      }
      this.queued.delete(nextFileId);
      const task = this.runCaption(nextFileId).finally(() => {
        this.running.delete(nextFileId);
        this.notifyWaiters(nextFileId);
        this.pump();
      });
      this.running.set(nextFileId, task);
    }
  }

  private async runCaption(fileId: string): Promise<void> {
    const modelRef = this.resolveModelRefs();
    try {
      const file = await this.chatFileStore.getFile(fileId);
      if (!file || !isCaptionableFile(file) || file.caption) {
        return;
      }
      const prepared = await this.mediaVisionService.prepareFileForModel(fileId);
      const result = await this.llmClient.generate({
        modelRefOverride: modelRef,
        timeoutMsOverride: this.config.llm.imageCaptioner.timeoutMs,
        enableThinkingOverride: this.config.llm.imageCaptioner.enableThinking,
        preferNativeNoThinkingChatEndpoint: true,
        skipDebugDump: true,
        messages: [
          ...buildCaptionPrompt(),
          {
            role: "user",
            content: [
              {
                type: "text",
                text: file.sourceContext.mediaKind === "emoji"
                  ? "请为这张聊天表情图生成一句极短描述。"
                  : "请为这张聊天图片生成一句极短描述。"
              },
              {
                type: "image_url",
                image_url: {
                  url: prepared.inputUrl
                }
              }
            ]
          }
        ]
      });
      const fallbackLabel = file.sourceContext.mediaKind === "emoji" ? "一个聊天表情" : "一张聊天图片";
      const caption = normalizeCaption(result.text, fallbackLabel);
      await this.chatFileStore.updateCaption(fileId, caption);
      this.logger.debug({
        fileId,
        modelRef: result.usage.modelRef ?? normalizeModelRefs(modelRef)[0] ?? "unknown",
        caption
      }, "media_caption_succeeded");
    } catch (error: unknown) {
      this.logger.warn({
        fileId,
        error: error instanceof Error ? error.message : String(error)
      }, "media_caption_failed");
    }
  }

  private async waitForCompletion(fileId: string, abortSignal?: AbortSignal): Promise<void> {
    const existing = await this.chatFileStore.getFile(fileId);
    if (!existing || existing.caption || !isCaptionableFile(existing)) {
      return;
    }
    if (abortSignal?.aborted) {
      throw abortSignal.reason instanceof Error ? abortSignal.reason : new Error("Media caption wait aborted");
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.removeWaiter(fileId, waiter);
        reject(abortSignal?.reason instanceof Error ? abortSignal.reason : new Error("Media caption wait aborted"));
      };
      const waiter = () => {
        abortSignal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const listeners = this.waiters.get(fileId) ?? new Set<() => void>();
      listeners.add(waiter);
      this.waiters.set(fileId, listeners);
      abortSignal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private notifyWaiters(fileId: string): void {
    const listeners = this.waiters.get(fileId);
    if (!listeners) {
      return;
    }
    this.waiters.delete(fileId);
    for (const listener of listeners) {
      listener();
    }
  }

  private removeWaiter(fileId: string, waiter: () => void): void {
    const listeners = this.waiters.get(fileId);
    if (!listeners) {
      return;
    }
    listeners.delete(waiter);
    if (listeners.size === 0) {
      this.waiters.delete(fileId);
    }
  }

  private resolveModelRefs(): string[] {
    return getModelRefsForRole(this.config, "image_captioner");
  }
}

function isCaptionableFile(file: ChatFileRecord): boolean {
  return file.kind === "image" || file.kind === "animated_image";
}

function uniqueIds(fileIds: string[]): string[] {
  return Array.from(new Set(fileIds.map((item) => String(item ?? "").trim()).filter(Boolean)));
}
