import type { ParsedIncomingMessage } from "../messaging/incomingMessage.ts";
import { decodeQqMessageContent } from "./embeddedMessages.ts";
import { normalizeQqAddressing } from "./messageAddressing.ts";
import type { QqReplyPermitRegistry } from "./replyPermit.ts";
import type { QqReplyPermit } from "./types.ts";

interface QqIncomingBase {
  messageId: string;
  timestampMs: number;
}
type OfficialMessage = Omit<ParsedIncomingMessage, "replyContext"> & {
  source: "qq_official";
  sourceRef: { platform: "qq_official"; connectionId: string; messageId: string; referenceId?: string };
};
export interface QqInteractiveIncoming extends QqIncomingBase {
  contextOnly: false;
  permit: QqReplyPermit;
  message: OfficialMessage & { replyContext: QqReplyPermit };
}
export interface QqContextIncoming extends QqIncomingBase {
  contextOnly: true;
  permit?: never;
  message: OfficialMessage & { replyContext?: never };
}
export type QqOfficialIncoming = QqInteractiveIncoming | QqContextIncoming;
export interface QqDecodeOptions {
  groupContext?: "mentions_only" | "all_received";
  selfId?: string | undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function string(value: unknown): string { return typeof value === "string" ? value : ""; }

/** The event type and platform mention entities establish addressing; body text is never authoritative. */
export function decodeQqMessage(type: "GROUP_AT_MESSAGE_CREATE" | "C2C_MESSAGE_CREATE", data: unknown, registry: QqReplyPermitRegistry, options?: QqDecodeOptions): QqInteractiveIncoming | null;
export function decodeQqMessage(type: string, data: unknown, registry: QqReplyPermitRegistry, options?: QqDecodeOptions): QqOfficialIncoming | null;
export function decodeQqMessage(type: string, data: unknown, registry: QqReplyPermitRegistry, options: QqDecodeOptions = {}): QqOfficialIncoming | null {
  const fullGroup = type === "GROUP_MESSAGE_CREATE";
  if (type !== "GROUP_AT_MESSAGE_CREATE" && type !== "C2C_MESSAGE_CREATE" && !fullGroup) return null;
  if (fullGroup && options.groupContext !== "all_received") return null;
  const event = record(data);
  const author = record(event.author);
  if (author.bot === true) return null;
  const group = type !== "C2C_MESSAGE_CREATE";
  const externalUserId = string(group ? author.member_openid : author.user_openid) || string(author.id);
  const targetId = group ? string(event.group_openid) : externalUserId;
  const messageId = string(event.id);
  const timestampMs = Date.parse(string(event.timestamp));
  if (!externalUserId || !targetId || !messageId || !Number.isFinite(timestampMs)) return null;
  const addressed = !fullGroup || hasSelfMention(event.mentions, options.selfId);
  const expired = timestampMs + 5 * 60_000 <= Date.now();
  if (!fullGroup && expired) return null;
  if (options.selfId && [author.id, author.member_openid, author.user_openid].includes(options.selfId)) return null;
  const permit = addressed && !expired ? registry.issue({ chatType: group ? "group" : "private", targetId, messageId, timestampMs }) : undefined;
  const mentions = (Array.isArray(event.mentions) ? event.mentions.slice(0, 200) : []).map((item) => {
    const user = record(item); return string(user.member_openid) || string(user.user_openid) || string(user.id);
  }).filter(Boolean);
  const ext = record(event.message_scene).ext;
  const reference = (Array.isArray(ext) ? ext : []).find((item): item is string => typeof item === "string" && item.startsWith("ref_msg_idx="));
  const ownIndex = (Array.isArray(ext) ? ext : []).find((item): item is string => typeof item === "string" && item.startsWith("msg_idx="))?.slice("msg_idx=".length, "msg_idx=".length + 160);
  const decodedContent = decodeQqMessageContent(event, reference?.slice("ref_msg_idx=".length));
  const normalized = normalizeQqAddressing(decodedContent.parts, Array.isArray(event.mentions) ? event.mentions : [], options.selfId);
  const text = normalized.text;
  const message: OfficialMessage = {
      source: "qq_official", sourceRef: { platform: "qq_official", connectionId: registry.connectionId, messageId, ...(ownIndex ? { referenceId: ownIndex } : {}) },
      channelId: registry.connectionId, externalUserId, chatType: group ? "group" : "private", userId: externalUserId,
      ...(group ? { groupId: targetId } : {}), senderName: string(author.username) || externalUserId,
      text, contentParts: normalized.parts, remoteAttachments: decodedContent.remoteAttachments, images: decodedContent.images, audioSources: decodedContent.audioSources, audioIds: [], emojiSources: [], imageIds: [], emojiIds: [],
      forwardIds: [], replyMessageId: reference?.slice("ref_msg_idx=".length) || null,
      mentionUserIds: mentions, mentionedAll: normalized.parts.some(part => part.kind === "mention" && part.target === "all"), isAtMentioned: group && addressed,
      ...(decodedContent.specialSegments.length ? { specialSegments: decodedContent.specialSegments } : {})
  };
  return permit
    ? { contextOnly: false, permit, messageId, timestampMs, message: { ...message, replyContext: permit } }
    : { contextOnly: true, messageId, timestampMs, message };
}

function hasSelfMention(value: unknown, selfId: string | undefined): boolean {
  const mentions = Array.isArray(value) ? value.slice(0, 200) : [];
  return mentions.some(raw => {
    const mention = record(raw);
    if (mention.scope === "all") return false;
    if (mention.is_you === true) return true;
    return Boolean(selfId && [mention.id, mention.member_openid, mention.user_openid].includes(selfId));
  });
}
