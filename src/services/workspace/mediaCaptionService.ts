import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { normalizeModelRefs } from "#llm/shared/modelProfiles.ts";
import { getModelRefsForRole } from "#llm/shared/modelRouting.ts";
import type { LlmClient, LlmMessage } from "#llm/llmClient.ts";
import { KeyedDerivationRunner } from "#llm/derivations/keyedDerivationRunner.ts";
import type { ChatFileStore } from "./chatFileStore.ts";
import type { MediaVisionService } from "./mediaVisionService.ts";
import type { ChatFileRecord } from "./types.ts";

function buildCaptionPrompt(): LlmMessage[] {
  return [
    {
      role: "system",
      content: [
        "你是图片描述生成器，只负责为聊天里的单张图片生成尽可能详细的中文描述，供不支持视觉输入的语言模型理解图片内容。",
        "只描述画面中可直接看见的信息，不要脑补看不见的背景、身份、动机或事实。",
        "请尽可能覆盖：主体、动作、场景、构图、穿着或外观、表情姿态、颜色、空间位置、物体关系、截图界面、图表结构、画面中的可见文字、可见状态和任何会影响聊天理解的细节。",
        "如果是表情包或梗图，描述人物/动物/角色、动作表情、字幕文字、整体情绪和可能表达的聊天语气。",
        "如果是应用、网页、聊天记录、报错、图表或文档截图，重点完整转写可见文字、按钮、字段、数值、错误信息和布局关系。",
        "如果画面含明显成人裸露、性暗示或其他 NSFW 内容，必须在开头加“NSFW ”，再用克制、中性、不露骨的中文描述可见内容。",
        "输出一段中文纯文本，不要加引号、编号、Markdown 或额外解释；信息越完整越好。"
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
  return isNsfw ? `NSFW ${normalized}` : normalized;
}

export class MediaCaptionService {
  private readonly runner: KeyedDerivationRunner;

  constructor(
    private readonly config: AppConfig,
    private readonly llmClient: LlmClient,
    private readonly chatFileStore: Pick<ChatFileStore, "getFile" | "getMany" | "markCaptionsQueued" | "updateCaption">,
    private readonly mediaVisionService: Pick<MediaVisionService, "prepareFileForModel">,
    private readonly logger: Logger
  ) {
    this.runner = new KeyedDerivationRunner({
      name: "media_caption",
      maxConcurrency: () => this.config.llm.imageCaptioner.maxConcurrency,
      run: (fileId) => this.runCaption(fileId),
      logger: this.logger
    });
  }

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
        .filter((item) => typeof item.caption === "string" && item.caption.length > 0 && item.captionStatus !== "failed")
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
    await this.chatFileStore.markCaptionsQueued(pendingIds);
    this.logger.debug({ fileCount: pendingIds.length, reason }, "media_caption_enqueued");
    this.runner.enqueue(pendingIds, { reason });
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
      const resolvedModelRef = result.usage.modelRef ?? normalizeModelRefs(modelRef)[0] ?? "unknown";
      await this.chatFileStore.updateCaption(fileId, caption, {
        status: "ready",
        modelRef: resolvedModelRef,
        error: null
      });
      this.logger.debug({
        fileId,
        modelRef: resolvedModelRef,
        caption
      }, "media_caption_succeeded");
    } catch (error: unknown) {
      const resolvedModelRef = normalizeModelRefs(modelRef)[0] ?? "unknown";
      await this.chatFileStore.updateCaption(fileId, null, {
        status: "failed",
        modelRef: resolvedModelRef,
        error: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240)
      }).catch(() => undefined);
      this.logger.warn({
        fileId,
        modelRef: resolvedModelRef,
        error: error instanceof Error ? error.message : String(error)
      }, "media_caption_failed");
    }
  }

  private async waitForCompletion(fileId: string, abortSignal?: AbortSignal): Promise<void> {
    const existing = await this.chatFileStore.getFile(fileId);
    if (!existing || existing.caption || existing.captionStatus === "failed" || !isCaptionableFile(existing)) {
      return;
    }
    await this.runner.waitForCompletion(fileId, abortSignal);
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
