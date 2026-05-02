import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { AudioStore } from "#audio/audioStore.ts";
import type { ChatFileStore } from "#services/workspace/chatFileStore.ts";
import type { ChatAttachment } from "#services/workspace/types.ts";
import {
  dedupeResolvedChatAttachments,
  getVisualAttachmentSemanticKind
} from "#services/workspace/chatAttachments.ts";
import { extractStructuredMediaReferences } from "#images/imageReferences.ts";
import type { LlmContentPart, LlmMessage } from "#llm/llmClient.ts";
import { contentSafetyHashText } from "./contentSafetyHash.ts";
import { buildContentSafetyMarker } from "./contentSafetyMarker.ts";
import type {
  ContentModerationProvider,
  ContentSafetyAuditRecord,
  ContentSafetyEvent,
  ModerateMediaInput,
  ModerateTextInput,
  ModerationResult,
  ModerationSubjectKind
} from "./contentSafetyTypes.ts";
import { ContentSafetyStore } from "./contentSafetyStore.ts";
import { createAliyunContentModerationProvider } from "./providers/aliyunContentModerationProvider.ts";
import { createKeywordContentSafetyProvider } from "./providers/keywordContentSafetyProvider.ts";
import { createNoopContentSafetyProvider } from "./providers/noopContentSafetyProvider.ts";

type RuleConfig = AppConfig["contentSafety"]["profiles"][string]["text"];

type TextProjection = {
  projectedText: string;
  events: ContentSafetyEvent[];
};

type PromptTextItem = {
  input: ModerateTextInput;
  rule: RuleConfig;
  apply: (projection: TextProjection) => void;
};

type PromptSafetyHistoryMessage = {
  role: "user" | "assistant";
  content: string;
  timestampMs?: number | null;
};

type PromptSafetyBatchMessage = {
  text: string;
  userId?: string | undefined;
  audioIds?: string[] | undefined;
  audioSources?: string[] | undefined;
  imageIds?: string[] | undefined;
  emojiIds?: string[] | undefined;
  attachments?: ChatAttachment[] | undefined;
  specialSegments?: Array<{ type: string; summary: string }> | undefined;
};

export class ContentSafetyService {
  private readonly warningCache = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly store: ContentSafetyStore,
    private readonly chatFileStore: Pick<ChatFileStore, "getFile" | "resolveAbsolutePath">,
    private readonly audioStore?: Pick<AudioStore, "get"> | undefined
  ) {}

  async projectPromptMessages<
    H extends PromptSafetyHistoryMessage,
    B extends PromptSafetyBatchMessage
  >(input: {
    sessionId: string;
    source: string;
    recentMessages: H[];
    batchMessages: B[];
    abortSignal?: AbortSignal | undefined;
  }): Promise<{
    recentMessages: H[];
    batchMessages: B[];
    events: ContentSafetyEvent[];
  }> {
    if (!this.config.contentSafety.enabled) {
      return {
        recentMessages: input.recentMessages,
        batchMessages: input.batchMessages,
        events: []
      };
    }

    const profile = this.resolvePromptProfile();
    if (!profile) {
      return {
        recentMessages: input.recentMessages,
        batchMessages: input.batchMessages,
        events: []
      };
    }

    const recentMessages = input.recentMessages.map((message) => ({ ...message }));
    const batchMessages = input.batchMessages.map((message) => ({ ...message }));
    const items: PromptTextItem[] = [];
    const events: ContentSafetyEvent[] = [];

    for (const [index, message] of recentMessages.entries()) {
      if (message.role !== "user" || !message.content.trim()) {
        continue;
      }
      items.push({
        input: {
          subjectKind: "text",
          text: message.content,
          context: {
            sessionId: input.sessionId,
            source: input.source
          },
          ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
        },
        rule: profile.text,
        apply: (projection) => {
          recentMessages[index] = {
            ...message,
            content: projection.projectedText
          };
          events.push(...projection.events);
        }
      });
    }

    for (const [index, message] of batchMessages.entries()) {
      if (!message.text.trim()) {
        // Special segments below can still carry prompt-visible text.
      } else {
        items.push({
          input: {
            subjectKind: "text",
            text: message.text,
            context: {
              sessionId: input.sessionId,
              ...(message.userId ? { userId: message.userId } : {}),
              source: input.source
            },
            ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
          },
          rule: profile.text,
          apply: (projection) => {
            batchMessages[index] = {
              ...batchMessages[index]!,
              text: projection.projectedText
            };
            events.push(...projection.events);
          }
        });
      }
      for (const [segmentIndex, segment] of (message.specialSegments ?? []).entries()) {
        if (!segment.summary.trim()) {
          continue;
        }
        items.push({
          input: {
            subjectKind: "text",
            text: segment.summary,
            context: {
              sessionId: input.sessionId,
              ...(message.userId ? { userId: message.userId } : {}),
              source: `${input.source}_special_segment`
            },
            ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
          },
          rule: profile.text,
          apply: (projection) => {
            const current = batchMessages[index]!;
            const specialSegments = (current.specialSegments ?? []).map((item, itemIndex) => (
              itemIndex === segmentIndex
                ? { ...item, summary: projection.projectedText }
                : item
            ));
            batchMessages[index] = {
              ...current,
              specialSegments
            };
            events.push(...projection.events);
          }
        });
      }
    }

    const projections = await this.projectTextItems(items);
    for (let index = 0; index < items.length; index += 1) {
      items[index]?.apply(projections[index] ?? allowProjection(items[index]!.input.text));
    }

    await this.projectPromptMedia({
      sessionId: input.sessionId,
      source: input.source,
      profile,
      recentMessages,
      batchMessages,
      events,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
    });

    return {
      recentMessages,
      batchMessages,
      events
    };
  }

  async projectLlmMessages(input: {
    sessionId: string;
    source: string;
    messages: LlmMessage[];
    abortSignal?: AbortSignal | undefined;
  }): Promise<{
    messages: LlmMessage[];
    events: ContentSafetyEvent[];
  }> {
    if (!this.config.contentSafety.enabled) {
      return {
        messages: input.messages,
        events: []
      };
    }

    const profile = this.resolvePromptProfile();
    if (!profile) {
      return {
        messages: input.messages,
        events: []
      };
    }

    const messages = input.messages.map((message) => ({
      ...message,
      content: Array.isArray(message.content)
        ? message.content.map((part) => ({ ...part }))
        : message.content
    }));
    const items: PromptTextItem[] = [];
    const events: ContentSafetyEvent[] = [];

    for (const [index, message] of messages.entries()) {
      if (!shouldModerateLlmMessageRole(message.role) || typeof message.content !== "string" || !message.content.trim()) {
        continue;
      }
      items.push({
        input: {
          subjectKind: "text",
          text: message.content,
          context: {
            sessionId: input.sessionId,
            source: input.source
          },
          ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
        },
        rule: profile.text,
        apply: (projection) => {
          messages[index] = {
            ...message,
            content: projection.projectedText
          };
          events.push(...projection.events);
        }
      });
    }
    for (const [messageIndex, message] of messages.entries()) {
      if (!shouldModerateLlmMessageRole(message.role) || !Array.isArray(message.content)) {
        continue;
      }
      for (const [partIndex, part] of message.content.entries()) {
        if (part.type !== "text" || !part.text.trim()) {
          continue;
        }
        items.push({
          input: {
            subjectKind: "text",
            text: part.text,
            context: {
              sessionId: input.sessionId,
              source: `${input.source}_content_part`
            },
            ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
          },
          rule: profile.text,
          apply: (projection) => {
            const current = messages[messageIndex]!;
            if (!Array.isArray(current.content)) {
              return;
            }
            current.content[partIndex] = {
              ...part,
              text: projection.projectedText
            };
            events.push(...projection.events);
          }
        });
      }
    }

    const projections = await this.projectTextItems(items);
    for (let index = 0; index < items.length; index += 1) {
      items[index]?.apply(projections[index] ?? allowProjection(items[index]!.input.text));
    }

    await this.projectLlmMessageMediaReferences({
      sessionId: input.sessionId,
      source: input.source,
      messages,
      events,
      profile,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
    });
    await this.projectLlmMessageContentPartMedia({
      sessionId: input.sessionId,
      source: input.source,
      messages,
      events,
      profile,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
    });

    return {
      messages,
      events
    };
  }

  async guardChatFileForLlm(fileId: string): Promise<"allow" | { blocked: true; marker: string; reason: string }> {
    if (!this.config.contentSafety.enabled) {
      return "allow";
    }
    return await this.store.isBlockedFileId(fileId) ?? "allow";
  }

  async guardTextForLlm(text: string, context: ModerateTextInput["context"]): Promise<"allow" | { blocked: true; marker: string; reason: string }> {
    if (!this.config.contentSafety.enabled || !text.trim()) {
      return "allow";
    }
    const profile = this.resolvePromptProfile();
    if (!profile) {
      return "allow";
    }
    const projection = await this.projectSingleText({ subjectKind: "text", text, context }, profile.text);
    const event = projection.events[0];
    if (!event?.marker) {
      return "allow";
    }
    return {
      blocked: true,
      marker: event.marker,
      reason: event.reason
    };
  }

  async moderateText(input: ModerateTextInput, rule: RuleConfig): Promise<ModerationResult> {
    const provider = this.resolveProvider(rule.provider);
    if (!provider?.moderateText) {
      this.warnOnce("content_safety_text_provider_missing", {
        providerId: rule.provider ?? null
      }, "content_safety_provider_missing");
      return allowResult("unconfigured", "unconfigured");
    }
    try {
      return applyModerationRule(await provider.moderateText(input), rule);
    } catch (error: unknown) {
      this.logger.warn({ error: toSafeErrorLog(error), providerId: provider.id }, "content_safety_text_failed_allowing");
      return allowResult(provider.id, provider.type);
    }
  }

  async moderateMedia(input: ModerateMediaInput, rule: RuleConfig): Promise<ModerationResult> {
    const provider = this.resolveProvider(rule.provider);
    if (!provider?.moderateMedia) {
      this.warnOnce("content_safety_media_provider_missing", {
        providerId: rule.provider ?? null
      }, "content_safety_provider_missing");
      return allowResult("unconfigured", "unconfigured");
    }
    try {
      return applyModerationRule(await provider.moderateMedia(input), rule);
    } catch (error: unknown) {
      this.logger.warn({ error: toSafeErrorLog(error), providerId: provider.id }, "content_safety_media_failed_allowing");
      return allowResult(provider.id, provider.type);
    }
  }

  private async projectPromptMedia<
    H extends PromptSafetyHistoryMessage,
    B extends PromptSafetyBatchMessage
  >(input: {
    sessionId: string;
    source: string;
    profile: NonNullable<ReturnType<ContentSafetyService["resolvePromptProfile"]>>;
    recentMessages: H[];
    batchMessages: B[];
    events: ContentSafetyEvent[];
    abortSignal?: AbortSignal | undefined;
  }): Promise<void> {
    for (const [index, message] of input.recentMessages.entries()) {
      const refs = extractStructuredMediaReferences(message.content);
      if (refs.length === 0) {
        continue;
      }
      const markers = new Map<string, ContentSafetyEvent>();
      for (const ref of refs) {
        const event = await this.projectMediaRef({
          sessionId: input.sessionId,
          source: input.source,
          subjectKind: ref.kind === "emoji" ? "emoji" : "image",
          fileId: ref.imageId,
          rule: ref.kind === "emoji" ? input.profile.emoji : input.profile.image,
          ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
        });
        if (event?.marker) {
          markers.set(ref.imageId, event);
          input.events.push(event);
        }
      }
      if (markers.size > 0) {
        input.recentMessages[index] = {
          ...message,
          content: replaceBlockedStructuredMediaReferences(message.content, markers)
        };
      }
    }

    for (const [index, message] of input.batchMessages.entries()) {
      const attachments = dedupeResolvedChatAttachments(message.attachments ?? []);
      const mediaRefs = collectPromptMessageMediaRefs(message, attachments);
      if (mediaRefs.length === 0) {
        continue;
      }
      const blockedFileIds = new Set<string>();
      const blockedAudioIds = new Set<string>();
      const blockedAudioSources = new Set<string>();
      let text = message.text;
      for (const media of mediaRefs) {
        const rule = media.kind === "emoji"
          ? input.profile.emoji
          : media.kind === "audio"
            ? input.profile.audio
            : input.profile.image;
        const event = media.kind === "audio"
          ? await this.projectAudioRef({
              sessionId: input.sessionId,
              source: input.source,
              audioId: media.fileId,
              sourceName: media.sourceName,
              rule,
              ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
            })
          : await this.projectMediaRef({
              sessionId: input.sessionId,
              source: input.source,
              subjectKind: media.kind,
              fileId: media.fileId,
              rule,
              ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
            });
        if (!event?.marker) {
          continue;
        }
        input.events.push(event);
        if (ruleHidesMediaFromProjection(rule)) {
          blockedFileIds.add(media.fileId);
          if (media.kind === "audio") {
            blockedAudioIds.add(media.fileId);
            if (media.sourceName) {
              blockedAudioSources.add(media.sourceName);
            }
          }
        }
        text = appendMarker(text, event.marker);
      }
      if (blockedFileIds.size > 0 || text !== message.text) {
        input.batchMessages[index] = {
          ...message,
          text,
          ...(message.audioIds ? { audioIds: message.audioIds.filter((audioId) => !blockedAudioIds.has(audioId)) } : {}),
          ...(message.audioSources ? { audioSources: message.audioSources.filter((source) => !blockedAudioSources.has(source)) } : {}),
          ...(message.imageIds ? { imageIds: message.imageIds.filter((fileId) => !blockedFileIds.has(fileId)) } : {}),
          ...(message.emojiIds ? { emojiIds: message.emojiIds.filter((fileId) => !blockedFileIds.has(fileId)) } : {}),
          ...(message.attachments ? { attachments: attachments.filter((attachment) => !blockedFileIds.has(attachment.fileId)) } : {})
        };
      }
    }
  }

  private async projectLlmMessageMediaReferences(input: {
    sessionId: string;
    source: string;
    profile: NonNullable<ReturnType<ContentSafetyService["resolvePromptProfile"]>>;
    messages: LlmMessage[];
    events: ContentSafetyEvent[];
    abortSignal?: AbortSignal | undefined;
  }): Promise<void> {
    for (const [index, message] of input.messages.entries()) {
      if (!shouldModerateLlmMessageRole(message.role) || typeof message.content !== "string") {
        continue;
      }
      const refs = extractStructuredMediaReferences(message.content);
      if (refs.length === 0) {
        continue;
      }
      const markers = new Map<string, ContentSafetyEvent>();
      for (const ref of refs) {
        const event = await this.projectMediaRef({
          sessionId: input.sessionId,
          source: input.source,
          subjectKind: ref.kind === "emoji" ? "emoji" : "image",
          fileId: ref.imageId,
          rule: ref.kind === "emoji" ? input.profile.emoji : input.profile.image,
          ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
        });
        if (event?.marker) {
          markers.set(ref.imageId, event);
          input.events.push(event);
        }
      }
      if (markers.size > 0) {
        input.messages[index] = {
          ...message,
          content: replaceBlockedStructuredMediaReferences(message.content, markers)
        };
      }
    }
  }

  private async projectLlmMessageContentPartMedia(input: {
    sessionId: string;
    source: string;
    profile: NonNullable<ReturnType<ContentSafetyService["resolvePromptProfile"]>>;
    messages: LlmMessage[];
    events: ContentSafetyEvent[];
    abortSignal?: AbortSignal | undefined;
  }): Promise<void> {
    for (const [messageIndex, message] of input.messages.entries()) {
      if (!shouldModerateLlmMessageRole(message.role) || !Array.isArray(message.content)) {
        continue;
      }
      const nextParts: LlmContentPart[] = [];
      for (const [partIndex, part] of message.content.entries()) {
        if (part.type === "image_url") {
          const event = await this.projectContentPartMedia({
            sessionId: input.sessionId,
            source: input.source,
            subjectKind: "local_media",
            sourceName: `content_part:${messageIndex}:${partIndex}:image`,
            mediaUrl: part.image_url.url,
            rule: input.profile.image,
            ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
          });
          if (event?.marker) {
            input.events.push(event);
            nextParts.push({ type: "text", text: event.marker });
            continue;
          }
        }
        if (part.type === "input_audio") {
          const event = await this.projectContentPartMedia({
            sessionId: input.sessionId,
            source: input.source,
            subjectKind: "audio",
            sourceName: `content_part:${messageIndex}:${partIndex}:audio`,
            data: part.input_audio.data,
            mimeType: part.input_audio.mimeType,
            format: part.input_audio.format,
            rule: input.profile.audio,
            ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
          });
          if (event?.marker) {
            input.events.push(event);
            nextParts.push({ type: "text", text: event.marker });
            continue;
          }
        }
        nextParts.push(part);
      }
      input.messages[messageIndex] = {
        ...message,
        content: nextParts
      };
    }
  }

  private async projectMediaRef(input: {
    sessionId: string;
    source: string;
    subjectKind: "image" | "emoji";
    fileId: string;
    rule: RuleConfig;
    abortSignal?: AbortSignal | undefined;
  }): Promise<ContentSafetyEvent | null> {
    const cached = await this.store.getByFileId(input.fileId);
    if (cached && shouldProjectAsBlocked(cached.result)) {
      return contentSafetyEventFromRecord(cached);
    }
    const file = await this.chatFileStore.getFile(input.fileId).catch(() => null);
    const absolutePath = file ? await this.chatFileStore.resolveAbsolutePath(input.fileId).catch(() => undefined) : undefined;
    const result = await this.moderateMedia({
      subjectKind: input.subjectKind,
      fileId: input.fileId,
      sourceName: file?.sourceName ?? input.fileId,
      mimeType: file?.mimeType,
      absolutePath,
      context: {
        sessionId: input.sessionId,
        source: input.source
      },
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
    }, input.rule);
    if (!shouldProjectAsBlocked(result)) {
      return null;
    }
    const persisted = await this.persistAudit({
      subjectKind: input.subjectKind,
      result,
      subjectRef: `media_id=${input.fileId}`,
      sessionId: input.sessionId,
      fileId: input.fileId,
      sourceName: file?.sourceName ?? input.fileId
    });
    return persisted.event;
  }

  private async projectContentPartMedia(input: {
    sessionId: string;
    source: string;
    subjectKind: "audio" | "local_media";
    sourceName: string;
    rule: RuleConfig;
    mediaUrl?: string | undefined;
    data?: string | undefined;
    mimeType?: string | undefined;
    format?: string | undefined;
    abortSignal?: AbortSignal | undefined;
  }): Promise<ContentSafetyEvent | null> {
    let tempPath: string | null = null;
    try {
      const absolutePath = await resolveModerationMediaPath({
        source: input.mediaUrl,
        data: input.data,
        mimeType: input.mimeType,
        format: input.format
      });
      tempPath = absolutePath.cleanupPath ?? null;
      if (!absolutePath.path) {
        if (input.rule.action === "allow") {
          return null;
        }
        const persisted = await this.persistAudit({
          subjectKind: input.subjectKind,
          result: blockedUnsupportedMediaResult("unsupported_content_part_media"),
          subjectRef: input.sourceName,
          sessionId: input.sessionId,
          sourceName: input.sourceName
        });
        return persisted.event;
      }
      const result = await this.moderateMedia({
        subjectKind: input.subjectKind,
        sourceName: input.sourceName,
        mimeType: input.mimeType,
        absolutePath: absolutePath.path,
        context: {
          sessionId: input.sessionId,
          source: input.source
        },
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
      }, input.rule);
      if (!shouldProjectAsBlocked(result)) {
        return null;
      }
      const persisted = await this.persistAudit({
        subjectKind: input.subjectKind,
        result,
        subjectRef: input.sourceName,
        sessionId: input.sessionId,
        sourceName: input.sourceName
      });
      return persisted.event;
    } finally {
      if (tempPath) {
        await unlink(tempPath).catch(() => undefined);
      }
    }
  }

  private async projectAudioRef(input: {
    sessionId: string;
    source: string;
    audioId: string;
    sourceName?: string | undefined;
    rule: RuleConfig;
    abortSignal?: AbortSignal | undefined;
  }): Promise<ContentSafetyEvent | null> {
    const cached = await this.store.getByAudioId(input.audioId);
    if (cached && shouldProjectAsBlocked(cached.result)) {
      return contentSafetyEventFromRecord(cached);
    }
    const audio = await this.audioStore?.get(input.audioId).catch(() => null);
    const sourceName = audio?.source ?? input.sourceName ?? input.audioId;
    const absolutePath = (await resolveModerationMediaPath({ source: sourceName })).path;
    if (!absolutePath && input.rule.action !== "allow") {
      const persisted = await this.persistAudit({
        subjectKind: "audio",
        result: blockedUnsupportedMediaResult("unsupported_audio_source"),
        subjectRef: `audio_id=${input.audioId}`,
        sessionId: input.sessionId,
        audioId: input.audioId,
        sourceName
      });
      return persisted.event;
    }
    const result = await this.moderateMedia({
      subjectKind: "audio",
      fileId: input.audioId,
      sourceName,
      ...(absolutePath ? { absolutePath } : {}),
      context: {
        sessionId: input.sessionId,
        source: input.source
      },
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
    }, input.rule);
    if (!shouldProjectAsBlocked(result)) {
      return null;
    }
    const persisted = await this.persistAudit({
      subjectKind: "audio",
      result,
      subjectRef: `audio_id=${input.audioId}`,
      sessionId: input.sessionId,
      audioId: input.audioId,
      sourceName
    });
    return persisted.event;
  }

  private async projectTextItems(items: PromptTextItem[]): Promise<TextProjection[]> {
    if (items.length === 0) {
      return [];
    }

    const results: Array<TextProjection | null> = await Promise.all(items.map((item) => this.projectCachedText(item.input, item.rule)));
    const unchecked = items
      .map((item, index) => ({ item, index }))
      .filter(({ index }) => results[index] == null);

    const textBatchConfig = this.config.contentSafety.textBatch;
    const groups = buildPromptTextGroups(
      unchecked,
      textBatchConfig.enabled
        ? {
            maxMessages: textBatchConfig.maxMessages,
            maxChars: textBatchConfig.maxChars,
            singleMessageMaxChars: textBatchConfig.singleMessageMaxChars
          }
        : {
            maxMessages: 1,
            maxChars: 1,
            singleMessageMaxChars: 1
          }
    );

    for (const group of groups) {
      const groupResults = await this.projectTextGroup(group.map((entry) => entry.item));
      for (let index = 0; index < group.length; index += 1) {
        const target = group[index];
        const projection = groupResults[index];
        if (!target || !projection) {
          continue;
        }
        results[target.index] = projection;
      }
    }

    return results.map((item, index) => item ?? allowProjection(items[index]!.input.text));
  }

  private async projectTextGroup(items: PromptTextItem[]): Promise<TextProjection[]> {
    if (items.length === 0) {
      return [];
    }
    if (items.length === 1) {
      return [await this.projectSingleText(items[0]!.input, items[0]!.rule)];
    }

    const combinedInput: ModerateTextInput = {
      ...items[0]!.input,
      text: buildBatchModerationText(items.map((item) => item.input.text)),
      context: {
        ...items[0]!.input.context,
        source: `${items[0]!.input.context.source ?? "prompt"}_text_batch`
      }
    };
    const batchResult = await this.moderateText(combinedInput, items[0]!.rule);
    if (!shouldProjectAsBlocked(batchResult)) {
      await Promise.all(items.map((item) => this.persistTextDecision({
        input: item.input,
        result: {
          ...batchResult,
          checkedAtMs: Date.now()
        },
        emitEvent: false
      })));
      return items.map((item) => allowProjection(item.input.text));
    }

    return await mapWithConcurrency(
      items,
      this.config.contentSafety.textBatch.maxLocateConcurrency,
      async (item) => await this.projectSingleText(item.input, item.rule)
    );
  }

  private async projectSingleText(input: ModerateTextInput, rule: RuleConfig): Promise<TextProjection> {
    const cached = await this.projectCachedText(input, rule);
    if (cached) {
      return cached;
    }
    const result = await this.moderateText(input, rule);
    const persisted = await this.persistTextDecision({
      input,
      result,
      emitEvent: shouldProjectAsBlocked(result)
    });
    if (!persisted?.event || !shouldProjectAsBlocked(result)) {
      return allowProjection(input.text);
    }
    return projectBlockedText(input.text, rule, persisted.event.marker ?? "", persisted.event);
  }

  private async projectCachedText(input: ModerateTextInput, rule: RuleConfig): Promise<TextProjection | null> {
    const cached = await this.readTextCache(input.text);
    if (!cached) {
      return null;
    }
    if (!shouldProjectAsBlocked(cached.result)) {
      return allowProjection(input.text);
    }
    if (input.context.sessionId && cached.sessionId !== input.context.sessionId) {
      const persisted = await this.persistAudit({
        subjectKind: input.subjectKind,
        result: cached.result,
        subjectRef: "text",
        sessionId: input.context.sessionId,
        originalText: input.text,
        contentHash: contentSafetyHashText(input.text),
        auditKey: `${cached.key}:session:${input.context.sessionId}`
      });
      return projectBlockedText(input.text, rule, persisted.marker, persisted.event);
    }
    const event = contentSafetyEventFromRecord(cached);
    return projectBlockedText(input.text, rule, cached.marker, event);
  }

  private async readTextCache(text: string): Promise<ContentSafetyAuditRecord | null> {
    if (!this.config.contentSafety.cache.enabled) {
      return null;
    }
    const record = await this.store.getByKey(this.textCacheKey(text));
    if (!record) {
      return null;
    }
    if (record.expiresAtMs !== undefined && record.expiresAtMs <= Date.now()) {
      return null;
    }
    return record;
  }

  private async persistTextDecision(input: {
    input: ModerateTextInput;
    result: ModerationResult;
    emitEvent: boolean;
  }): Promise<{ marker: string; event: ContentSafetyEvent } | null> {
    const blocked = shouldProjectAsBlocked(input.result);
    if (!blocked && (!this.config.contentSafety.cache.enabled || !this.config.contentSafety.cache.storeAllowResults)) {
      return null;
    }
    return await this.persistAudit({
      subjectKind: input.input.subjectKind,
      result: input.result,
      subjectRef: "text",
      sessionId: blocked ? input.input.context.sessionId : undefined,
      originalText: blocked ? input.input.text : undefined,
      contentHash: contentSafetyHashText(input.input.text),
      auditKey: this.textCacheKey(input.input.text),
      emitEvent: input.emitEvent
    });
  }

  private async persistAudit(input: {
    subjectKind: ModerationSubjectKind;
    result: ModerationResult;
    subjectRef?: string | undefined;
    sessionId?: string | undefined;
    originalText?: string | undefined;
    contentHash?: string | undefined;
    auditKey?: string | undefined;
    fileId?: string | undefined;
    audioId?: string | undefined;
    sourceName?: string | undefined;
    emitEvent?: boolean | undefined;
  }): Promise<{ marker: string; event: ContentSafetyEvent }> {
    const contentHash = input.contentHash ?? (input.originalText ? contentSafetyHashText(input.originalText) : undefined);
    const key = input.auditKey ?? (
      input.fileId
        ? `file:${input.fileId}`
        : input.audioId
          ? `audio:${input.audioId}`
          : contentHash
            ? `text:${contentHash}`
            : `${input.subjectKind}:${input.result.providerId}:${input.result.checkedAtMs}`
    );
    const marker = shouldProjectAsBlocked(input.result)
      ? buildContentSafetyMarker({
        subjectKind: input.subjectKind,
        result: input.result,
        subjectRef: input.subjectRef,
        auditKey: key,
        markerConfig: this.config.contentSafety.marker
      })
      : "";
    const record: ContentSafetyAuditRecord = {
      key,
      subjectKind: input.subjectKind,
      decision: input.result.decision,
      marker,
      result: input.result,
      ...(input.originalText && this.config.contentSafety.audit.preserveOriginalText
        ? { originalText: input.originalText.slice(0, this.config.contentSafety.audit.maxOriginalTextChars) }
        : {}),
      ...(input.fileId ? { fileId: input.fileId } : {}),
      ...(input.audioId ? { audioId: input.audioId } : {}),
      ...(contentHash ? { contentHash } : {}),
      ...(input.sourceName ? { sourceName: input.sourceName } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      checkedAtMs: input.result.checkedAtMs,
      ...(this.config.contentSafety.cache.enabled
        ? { expiresAtMs: input.result.checkedAtMs + this.config.contentSafety.cache.ttlMs }
        : {})
    };
    await this.store.upsert(record);
    const event = contentSafetyEventFromRecord(record);
    return {
      marker,
      event: input.emitEvent === false ? { ...event, marker: null, auditKey: null } : event
    };
  }

  private textCacheKey(text: string): string {
    return `text:v${this.config.contentSafety.cache.version}:${contentSafetyHashText(text)}`;
  }

  private resolvePromptProfile() {
    const routed = this.config.contentSafety.routes.prompt.preLlm;
    if (routed) {
      const profile = this.config.contentSafety.profiles[routed];
      if (profile) {
        return profile;
      }
      this.warnOnce(`content_safety_prompt_profile_missing:${routed}`, {
        profileId: routed
      }, "content_safety_prompt_profile_missing_allowing");
    }
    const first = Object.values(this.config.contentSafety.profiles)[0];
    return first ?? null;
  }

  private resolveProvider(providerId: string | undefined): ContentModerationProvider | null {
    const entries = Object.entries(this.config.contentSafety.providers)
      .filter(([, provider]) => provider.enabled);
    const selected = providerId
      ? entries.find(([id]) => id === providerId)
      : entries[0];
    if (!selected) {
      return null;
    }
    const [id, providerConfig] = selected;
    if (providerConfig.type === "noop") {
      return createNoopContentSafetyProvider(id);
    }
    if (providerConfig.type === "keyword") {
      return createKeywordContentSafetyProvider(id, providerConfig);
    }
    if (providerConfig.type === "aliyun_content_moderation") {
      return createAliyunContentModerationProvider(id, providerConfig);
    }
    this.warnOnce(`content_safety_provider_not_implemented:${id}`, {
      providerId: id,
      providerType: providerConfig.type
    }, "content_safety_provider_not_implemented_allowing");
    return null;
  }

  private warnOnce(cacheKey: string, payload: Record<string, unknown>, event: string): void {
    if (this.warningCache.has(cacheKey)) {
      return;
    }
    this.warningCache.add(cacheKey);
    this.logger.warn(payload, event);
  }
}

function buildPromptTextGroups(
  items: Array<{ item: PromptTextItem; index: number }>,
  config: {
    maxMessages: number;
    maxChars: number;
    singleMessageMaxChars: number;
  }
): Array<Array<{ item: PromptTextItem; index: number }>> {
  const groups: Array<Array<{ item: PromptTextItem; index: number }>> = [];
  let current: Array<{ item: PromptTextItem; index: number }> = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length > 0) {
      groups.push(current);
      current = [];
      currentChars = 0;
    }
  };

  for (const entry of items) {
    const length = entry.item.input.text.length;
    if (length > config.singleMessageMaxChars || length > config.maxChars) {
      flush();
      groups.push([entry]);
      continue;
    }
    if (
      current.length >= config.maxMessages
      || (current.length > 0 && currentChars + length > config.maxChars)
    ) {
      flush();
    }
    current.push(entry);
    currentChars += length;
  }

  flush();
  return groups;
}

function shouldProjectAsBlocked(result: ModerationResult): boolean {
  return result.decision === "block" || result.decision === "review";
}

function shouldModerateLlmMessageRole(role: LlmMessage["role"]): boolean {
  return role === "user" || role === "tool";
}

function ruleKeepsOriginalContent(rule: RuleConfig): boolean {
  return rule.action === "mark";
}

function ruleHidesMediaFromProjection(rule: RuleConfig): boolean {
  return rule.action === "hide_from_projection_and_mark"
    || rule.action === "mark_unavailable"
    || rule.action === "block_message";
}

function applyModerationRule(result: ModerationResult, rule: RuleConfig): ModerationResult {
  if (rule.action === "allow") {
    return {
      ...result,
      decision: "allow",
      reason: "allowed"
    };
  }
  const maxConfidence = Math.max(...result.labels
    .map((item) => item.confidence)
    .filter((item): item is number => typeof item === "number"), 0);
  const risks = collectRiskLevels(result);
  const blockByConfidence = rule.blockConfidenceGte !== undefined && maxConfidence >= rule.blockConfidenceGte;
  if (blockByConfidence || risks.some((risk) => rule.blockRiskLevels.includes(risk))) {
    return {
      ...result,
      decision: "block",
      reason: result.reason || "命中内容安全阻断策略"
    };
  }
  if (risks.some((risk) => rule.reviewRiskLevels.includes(risk))) {
    return {
      ...result,
      decision: "review",
      reason: result.reason || "命中内容安全复核策略"
    };
  }
  return {
    ...result,
    decision: "allow",
    reason: "allowed"
  };
}

function collectRiskLevels(result: ModerationResult): Array<NonNullable<import("./contentSafetyTypes.ts").ModerationLabel["riskLevel"]>> {
  const risks = result.labels
    .map((item) => item.riskLevel)
    .filter((item): item is NonNullable<import("./contentSafetyTypes.ts").ModerationLabel["riskLevel"]> => item !== undefined);
  if (risks.length === 0 && result.decision === "block") {
    return ["high"];
  }
  if (risks.length === 0 && result.decision === "review") {
    return ["medium"];
  }
  return risks;
}

function toSafeErrorLog(error: unknown): { message: string; name?: string; code?: unknown; status?: unknown; requestId?: unknown } {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }
  const details = error as Error & { code?: unknown; status?: unknown; requestId?: unknown };
  return {
    message: error.message,
    ...(error.name ? { name: error.name } : {}),
    ...(details.code !== undefined ? { code: details.code } : {}),
    ...(details.status !== undefined ? { status: details.status } : {}),
    ...(details.requestId !== undefined ? { requestId: details.requestId } : {})
  };
}

function allowResult(providerId: string, providerType: string): ModerationResult {
  return {
    decision: "allow",
    reason: "allowed",
    labels: [],
    providerId,
    providerType,
    checkedAtMs: Date.now()
  };
}

function blockedUnsupportedMediaResult(reason: string): ModerationResult {
  return {
    decision: "block",
    reason: "媒体内容无法被内容安全服务检查，已按不可见处理",
    labels: [{
      label: reason,
      category: "unsupported_media",
      riskLevel: "high",
      confidence: 100
    }],
    providerId: "local",
    providerType: "unsupported_media_policy",
    rawDecision: reason,
    checkedAtMs: Date.now()
  };
}

function appendMarker(text: string, marker: string): string {
  const trimmed = text.trim();
  return trimmed ? `${trimmed}\n${marker}` : marker;
}

function allowProjection(text: string): TextProjection {
  return {
    projectedText: text,
    events: []
  };
}

function projectBlockedText(text: string, rule: RuleConfig, marker: string, event: ContentSafetyEvent): TextProjection {
  return {
    projectedText: ruleKeepsOriginalContent(rule)
      ? appendMarker(text, marker)
      : marker,
    events: [event]
  };
}

function buildBatchModerationText(texts: string[]): string {
  const parts = texts.map((text, index) => [
    `⟦message index="${index}"⟧`,
    text,
    "⟦/message⟧"
  ].join("\n"));
  return [
    "以下是多条独立聊天消息。请只判断这批消息整体是否存在需要内容安全拦截或复核的内容，编号仅用于分隔，不属于原文。",
    ...parts
  ].join("\n\n");
}

function contentSafetyEventFromRecord(record: ContentSafetyAuditRecord): ContentSafetyEvent {
  return {
    subjectKind: record.subjectKind,
    decision: record.decision,
    marker: record.marker,
    auditKey: record.key,
    ...(record.fileId ? { fileId: record.fileId } : {}),
    ...(record.audioId ? { audioId: record.audioId } : {}),
    ...(record.contentHash ? { contentHash: record.contentHash } : {}),
    reason: record.result.reason
  };
}

function replaceBlockedStructuredMediaReferences(
  content: string,
  eventsByFileId: ReadonlyMap<string, ContentSafetyEvent>
): string {
  return content.replace(/⟦ref\s+kind="(image|emoji)"\s+image_id="([^"]+)"\s*⟧/gi, (full, _kind, rawImageId) => {
    const imageId = String(rawImageId ?? "").trim();
    return eventsByFileId.get(imageId)?.marker ?? full;
  });
}

function collectPromptMessageMediaRefs(
  message: PromptSafetyBatchMessage,
  attachments: ChatAttachment[]
): Array<{ fileId: string; kind: "image" | "emoji" | "audio"; sourceName?: string | undefined }> {
  const refs: Array<{ fileId: string; kind: "image" | "emoji" | "audio"; sourceName?: string | undefined }> = [];
  const seen = new Set<string>();
  const add = (fileId: string, kind: "image" | "emoji" | "audio", sourceName?: string | undefined) => {
    const normalized = String(fileId ?? "").trim();
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    refs.push({
      fileId: normalized,
      kind,
      ...(sourceName ? { sourceName } : {})
    });
  };
  const audioSources = message.audioSources ?? [];
  for (const [index, audioId] of (message.audioIds ?? []).entries()) {
    add(audioId, "audio", audioSources[index]);
  }
  for (const fileId of message.imageIds ?? []) {
    add(fileId, "image");
  }
  for (const fileId of message.emojiIds ?? []) {
    add(fileId, "emoji");
  }
  for (const attachment of attachments) {
    const kind = getVisualAttachmentSemanticKind(attachment);
    if (kind) {
      add(attachment.fileId, kind);
    }
  }
  return refs;
}

async function resolveModerationMediaPath(input: {
  source?: string | undefined;
  data?: string | undefined;
  mimeType?: string | undefined;
  format?: string | undefined;
}): Promise<{ path?: string | undefined; cleanupPath?: string | undefined }> {
  if (input.data) {
    const buffer = Buffer.from(input.data, "base64");
    const extension = extensionForMedia(input.mimeType, input.format);
    const dir = `${tmpdir()}/llm-onebot-content-safety`;
    await mkdir(dir, { recursive: true });
    const path = `${dir}/${randomUUID()}${extension}`;
    await writeFile(path, buffer);
    return { path, cleanupPath: path };
  }

  const source = String(input.source ?? "").trim();
  if (!source) {
    return {};
  }
  const dataUrlMatch = source.match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/i);
  if (dataUrlMatch) {
    return await resolveModerationMediaPath({
      data: String(dataUrlMatch[2] ?? ""),
      mimeType: String(dataUrlMatch[1] ?? "")
    });
  }
  if (/^https?:\/\//i.test(source)) {
    return { path: source };
  }
  if (source.startsWith("file://")) {
    return { path: fileURLToPath(source) };
  }
  if (isAbsolute(source) || extname(source)) {
    return { path: isAbsolute(source) ? source : `${process.cwd()}/${source}` };
  }
  return {};
}

function extensionForMedia(mimeType?: string | undefined, format?: string | undefined): string {
  const normalized = String(mimeType ?? "").toLowerCase();
  if (normalized.includes("png")) {
    return ".png";
  }
  if (normalized.includes("webp")) {
    return ".webp";
  }
  if (normalized.includes("gif")) {
    return ".gif";
  }
  if (normalized.includes("wav")) {
    return ".wav";
  }
  if (normalized.includes("ogg")) {
    return ".ogg";
  }
  if (normalized.includes("flac")) {
    return ".flac";
  }
  const normalizedFormat = String(format ?? "").toLowerCase();
  if (normalizedFormat) {
    return `.${normalizedFormat.replace(/[^a-z0-9]/g, "") || "bin"}`;
  }
  if (normalized.startsWith("audio/")) {
    return ".mp3";
  }
  return ".jpg";
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const limit = Math.max(1, Math.floor(concurrency));
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await mapper(items[index]!, index);
    }
  }));
  return results;
}
