import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { EnrichedIncomingMessage } from "#app/messaging/messageHandlerTypes.ts";
import {
  dedupeResolvedChatAttachments,
  getVisualAttachmentSemanticKind
} from "#services/workspace/chatAttachments.ts";
import type { ChatFileStore } from "#services/workspace/chatFileStore.ts";
import type { ChatAttachment } from "#services/workspace/types.ts";
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

type Delivery = "onebot" | "web";
type RuleConfig = AppConfig["contentSafety"]["profiles"][string]["text"];

export class ContentSafetyService {
  private readonly warningCache = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly store: ContentSafetyStore,
    private readonly chatFileStore: Pick<ChatFileStore, "getFile" | "resolveAbsolutePath">
  ) {}

  async moderateIncomingMessage(input: {
    message: EnrichedIncomingMessage;
    sessionId: string;
    delivery: Delivery;
    abortSignal?: AbortSignal | undefined;
  }): Promise<{
    rawMessage: EnrichedIncomingMessage;
    projectedMessage: EnrichedIncomingMessage;
    events: ContentSafetyEvent[];
    blocked: boolean;
  }> {
    if (!this.config.contentSafety.enabled) {
      return {
        rawMessage: input.message,
        projectedMessage: input.message,
        events: [],
        blocked: false
      };
    }

    const profile = this.resolveInboundProfile(input.delivery);
    if (!profile) {
      this.warnOnce("content_safety_profile_missing", {
        delivery: input.delivery
      }, "content_safety_profile_missing");
      return {
        rawMessage: input.message,
        projectedMessage: input.message,
        events: [],
        blocked: false
      };
    }

    const events: ContentSafetyEvent[] = [];
    let projectedText = input.message.text;
    const context = {
      sessionId: input.sessionId,
      delivery: input.delivery,
      userId: input.message.userId,
      ...(input.message.groupId ? { groupId: input.message.groupId } : {}),
      source: "incoming_message"
    };

    if (projectedText.trim()) {
      const textResult = await this.moderateText({
        subjectKind: "text",
        text: projectedText,
        context,
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
      }, profile.text);
      if (shouldProjectAsBlocked(textResult)) {
        const marker = await this.persistAudit({
          subjectKind: "text",
          result: textResult,
          subjectRef: "text",
          sessionId: input.sessionId,
          originalText: projectedText
        });
        projectedText = marker.marker;
        events.push(marker.event);
      }
    }

    const rawAttachments = dedupeResolvedChatAttachments(input.message.attachments ?? []);
    const mediaRefs = collectMessageMediaRefs(input.message, rawAttachments);
    const blockedFileIds = new Set<string>();

    for (const media of mediaRefs) {
      const file = await this.chatFileStore.getFile(media.fileId).catch(() => null);
      const absolutePath = file ? await this.chatFileStore.resolveAbsolutePath(media.fileId).catch(() => undefined) : undefined;
      const mediaResult = await this.moderateMedia({
        subjectKind: media.kind,
        fileId: media.fileId,
        sourceName: file?.sourceName ?? media.fileId,
        mimeType: file?.mimeType,
        absolutePath,
        context,
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
      }, media.kind === "emoji" ? profile.emoji : profile.image);
      if (!shouldProjectAsBlocked(mediaResult)) {
        continue;
      }
      const marker = await this.persistAudit({
        subjectKind: media.kind,
        result: mediaResult,
        subjectRef: `media_id=${media.fileId}`,
        sessionId: input.sessionId,
        fileId: media.fileId,
        sourceName: file?.sourceName ?? media.fileId
      });
      blockedFileIds.add(media.fileId);
      projectedText = appendMarker(projectedText, marker.marker);
      events.push(marker.event);
    }

    const projectedMessage: EnrichedIncomingMessage = {
      ...input.message,
      text: projectedText,
      imageIds: input.message.imageIds.filter((fileId) => !blockedFileIds.has(fileId)),
      emojiIds: input.message.emojiIds.filter((fileId) => !blockedFileIds.has(fileId)),
      attachments: rawAttachments.filter((attachment) => !blockedFileIds.has(attachment.fileId))
    };

    return {
      rawMessage: input.message,
      projectedMessage,
      events,
      blocked: events.some((event) => event.decision === "block" || event.decision === "review")
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
    const profile = this.resolveFirstProfile();
    if (!profile) {
      return "allow";
    }
    const result = await this.moderateText({ subjectKind: "text", text, context }, profile.text);
    if (!shouldProjectAsBlocked(result)) {
      return "allow";
    }
    const persisted = await this.persistAudit({
      subjectKind: "text",
      result,
      subjectRef: "text",
      sessionId: context.sessionId,
      originalText: text
    });
    return {
      blocked: true,
      marker: persisted.marker,
      reason: result.reason
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
      return await provider.moderateText(input);
    } catch (error: unknown) {
      this.logger.warn({ err: error, providerId: provider.id }, "content_safety_text_failed_allowing");
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
      return await provider.moderateMedia(input);
    } catch (error: unknown) {
      this.logger.warn({ err: error, providerId: provider.id }, "content_safety_media_failed_allowing");
      return allowResult(provider.id, provider.type);
    }
  }

  private async persistAudit(input: {
    subjectKind: ModerationSubjectKind;
    result: ModerationResult;
    subjectRef?: string | undefined;
    sessionId?: string | undefined;
    originalText?: string | undefined;
    fileId?: string | undefined;
    sourceName?: string | undefined;
  }): Promise<{ marker: string; event: ContentSafetyEvent }> {
    const marker = buildContentSafetyMarker({
      subjectKind: input.subjectKind,
      result: input.result,
      subjectRef: input.subjectRef,
      markerConfig: this.config.contentSafety.marker
    });
    const contentHash = input.originalText ? contentSafetyHashText(input.originalText) : undefined;
    const key = input.fileId
      ? `file:${input.fileId}`
      : contentHash
        ? `text:${contentHash}`
        : `${input.subjectKind}:${input.result.providerId}:${input.result.checkedAtMs}`;
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
      ...(contentHash ? { contentHash } : {}),
      ...(input.sourceName ? { sourceName: input.sourceName } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      checkedAtMs: input.result.checkedAtMs,
      ...(this.config.contentSafety.cache.enabled
        ? { expiresAtMs: input.result.checkedAtMs + this.config.contentSafety.cache.ttlMs }
        : {})
    };
    await this.store.upsert(record);
    return {
      marker,
      event: {
        subjectKind: input.subjectKind,
        decision: input.result.decision,
        marker,
        auditKey: key,
        ...(input.fileId ? { fileId: input.fileId } : {}),
        ...(contentHash ? { contentHash } : {}),
        reason: input.result.reason
      }
    };
  }

  private resolveInboundProfile(delivery: Delivery) {
    const profileId = delivery === "web"
      ? this.config.contentSafety.routes.inbound.web
      : this.config.contentSafety.routes.inbound.onebot;
    if (profileId && this.config.contentSafety.profiles[profileId]) {
      return this.config.contentSafety.profiles[profileId];
    }
    return this.resolveFirstProfile();
  }

  private resolveFirstProfile() {
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

function shouldProjectAsBlocked(result: ModerationResult): boolean {
  return result.decision === "block" || result.decision === "review";
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

function appendMarker(text: string, marker: string): string {
  const trimmed = text.trim();
  return trimmed ? `${trimmed}\n${marker}` : marker;
}

function collectMessageMediaRefs(
  message: EnrichedIncomingMessage,
  attachments: ChatAttachment[]
): Array<{ fileId: string; kind: "image" | "emoji" }> {
  const refs: Array<{ fileId: string; kind: "image" | "emoji" }> = [];
  const seen = new Set<string>();
  const add = (fileId: string, kind: "image" | "emoji") => {
    const normalized = String(fileId ?? "").trim();
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    refs.push({ fileId: normalized, kind });
  };
  for (const fileId of message.imageIds) {
    add(fileId, "image");
  }
  for (const fileId of message.emojiIds) {
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
