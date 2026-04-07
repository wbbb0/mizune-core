import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { normalizeModelRefs, resolveModelRefsForType } from "#llm/shared/modelProfiles.ts";
import type { LlmClient, LlmMessage } from "#llm/llmClient.ts";
import type { MediaWorkspace } from "./mediaWorkspace.ts";
import type { MediaVisionService } from "./mediaVisionService.ts";
import type { WorkspaceAssetRecord } from "./types.ts";

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
    private readonly mediaWorkspace: Pick<MediaWorkspace, "getAsset" | "getMany" | "updateCaption">,
    private readonly mediaVisionService: Pick<MediaVisionService, "prepareAssetForModel">,
    private readonly logger: Logger
  ) {}

  isEnabled(): boolean {
    const modelRefs = this.resolveModelRefs();
    return this.config.llm.enabled
      && this.config.llm.imageCaptioner.enabled
      && modelRefs.length > 0
      && this.llmClient.isConfigured(modelRefs);
  }

  async getCaptionMap(assetIds: string[]): Promise<Map<string, string>> {
    const assets = await this.mediaWorkspace.getMany(uniqueIds(assetIds));
    return new Map(
      assets
        .filter((item) => typeof item.caption === "string" && item.caption.length > 0)
        .map((item) => [item.assetId, item.caption as string])
    );
  }

  schedule(assetIds: string[], reason: string): void {
    if (!this.isEnabled()) {
      return;
    }
    void this.enqueue(uniqueIds(assetIds), reason);
  }

  async ensureReady(assetIds: string[], options?: { reason?: string; abortSignal?: AbortSignal }): Promise<Map<string, string>> {
    const ids = uniqueIds(assetIds);
    if (ids.length === 0) {
      return new Map();
    }
    if (!this.isEnabled()) {
      return this.getCaptionMap(ids);
    }
    await this.enqueue(ids, options?.reason ?? "ensure_ready");
    await Promise.all(ids.map((assetId) => this.waitForCompletion(assetId, options?.abortSignal)));
    return this.getCaptionMap(ids);
  }

  private async enqueue(assetIds: string[], reason: string): Promise<void> {
    const existing = await this.mediaWorkspace.getMany(assetIds);
    const pendingIds = existing
      .filter(isCaptionableAsset)
      .filter((item) => !item.caption)
      .map((item) => item.assetId);
    if (pendingIds.length === 0) {
      return;
    }
    for (const assetId of pendingIds) {
      if (this.queued.has(assetId) || this.running.has(assetId)) {
        continue;
      }
      this.queued.add(assetId);
      this.pending.push(assetId);
    }
    this.logger.debug({ assetCount: pendingIds.length, reason }, "media_caption_enqueued");
    this.pump();
  }

  private pump(): void {
    const maxConcurrency = this.config.llm.imageCaptioner.maxConcurrency;
    while (this.running.size < maxConcurrency) {
      const nextAssetId = this.pending.shift();
      if (!nextAssetId) {
        return;
      }
      this.queued.delete(nextAssetId);
      const task = this.runCaption(nextAssetId).finally(() => {
        this.running.delete(nextAssetId);
        this.notifyWaiters(nextAssetId);
        this.pump();
      });
      this.running.set(nextAssetId, task);
    }
  }

  private async runCaption(assetId: string): Promise<void> {
    const modelRef = this.resolveModelRefs();
    try {
      const asset = await this.mediaWorkspace.getAsset(assetId);
      if (!asset || !isCaptionableAsset(asset) || asset.caption) {
        return;
      }
      const prepared = await this.mediaVisionService.prepareAssetForModel(assetId);
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
                text: asset.sourceContext.mediaKind === "emoji"
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
      const fallbackLabel = asset.sourceContext.mediaKind === "emoji" ? "一个聊天表情" : "一张聊天图片";
      const caption = normalizeCaption(result.text, fallbackLabel);
      await this.mediaWorkspace.updateCaption(assetId, caption);
      this.logger.debug({
        assetId,
        modelRef: result.usage.modelRef ?? normalizeModelRefs(modelRef)[0] ?? "unknown",
        caption
      }, "media_caption_succeeded");
    } catch (error: unknown) {
      this.logger.warn({
        assetId,
        error: error instanceof Error ? error.message : String(error)
      }, "media_caption_failed");
    }
  }

  private async waitForCompletion(assetId: string, abortSignal?: AbortSignal): Promise<void> {
    const existing = await this.mediaWorkspace.getAsset(assetId);
    if (!existing || existing.caption || !isCaptionableAsset(existing)) {
      return;
    }
    if (abortSignal?.aborted) {
      throw abortSignal.reason instanceof Error ? abortSignal.reason : new Error("Media caption wait aborted");
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.removeWaiter(assetId, waiter);
        reject(abortSignal?.reason instanceof Error ? abortSignal.reason : new Error("Media caption wait aborted"));
      };
      const waiter = () => {
        abortSignal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const listeners = this.waiters.get(assetId) ?? new Set<() => void>();
      listeners.add(waiter);
      this.waiters.set(assetId, listeners);
      abortSignal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private notifyWaiters(assetId: string): void {
    const listeners = this.waiters.get(assetId);
    if (!listeners) {
      return;
    }
    this.waiters.delete(assetId);
    for (const listener of listeners) {
      listener();
    }
  }

  private removeWaiter(assetId: string, waiter: () => void): void {
    const listeners = this.waiters.get(assetId);
    if (!listeners) {
      return;
    }
    listeners.delete(waiter);
    if (listeners.size === 0) {
      this.waiters.delete(assetId);
    }
  }

  private resolveModelRefs(): string[] {
    const resolved = resolveModelRefsForType(this.config, this.config.llm.imageCaptioner.modelRef, "chat");
    return resolved.acceptedModelRefs;
  }
}

function isCaptionableAsset(asset: WorkspaceAssetRecord): boolean {
  return asset.kind === "image" || asset.kind === "animated_image";
}

function uniqueIds(assetIds: string[]): string[] {
  return Array.from(new Set(assetIds.map((item) => String(item ?? "").trim()).filter(Boolean)));
}
