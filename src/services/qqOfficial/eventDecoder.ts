import type { ParsedIncomingMessage } from "../messaging/incomingMessage.ts";
import type { MessageContentPart } from "#messages/contentParts.ts";
import type { QqReplyPermitRegistry } from "./replyPermit.ts";
import type { QqReplyPermit } from "./types.ts";

export interface QqOfficialIncoming {
  message: ParsedIncomingMessage & {
    source: "qq_official";
    sourceRef: { platform: "qq_official"; connectionId: string; messageId: string };
    replyContext: QqReplyPermit;
  };
  permit: QqReplyPermit;
  messageId: string;
  timestampMs: number;
}

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function string(value: unknown): string { return typeof value === "string" ? value : ""; }

/** Decoding only accepts verified gateway dispatch types, never user text claiming to mention the bot. */
export function decodeQqMessage(type: string, data: unknown, registry: QqReplyPermitRegistry): QqOfficialIncoming | null {
  if (type !== "GROUP_AT_MESSAGE_CREATE" && type !== "C2C_MESSAGE_CREATE") return null;
  const event = record(data);
  const author = record(event.author);
  if (author.bot === true) return null;
  const group = type === "GROUP_AT_MESSAGE_CREATE";
  const externalUserId = string(group ? author.member_openid : author.user_openid) || string(author.id);
  const targetId = group ? string(event.group_openid) : externalUserId;
  const messageId = string(event.id);
  const timestampMs = Date.parse(string(event.timestamp));
  if (!externalUserId || !targetId || !messageId || !Number.isFinite(timestampMs)) return null;
  if (timestampMs + 5 * 60_000 <= Date.now()) return null;
  const permit = registry.issue({ chatType: group ? "group" : "private", targetId, messageId, timestampMs });
  const parts: MessageContentPart[] = [];
  const text = string(event.content);
  if (text) parts.push({ kind: "text", text });
  const images: string[] = [];
  const audioSources: string[] = [];
  const remoteAttachments: NonNullable<ParsedIncomingMessage["remoteAttachments"]> = [];
  const specialSegments: Array<{ type: string; summary: string }> = [];
  for (const raw of Array.isArray(event.attachments) ? event.attachments : []) {
    const attachment = record(raw);
    const url = string(attachment.url);
    if (!/^https?:\/\//i.test(url)) continue;
    const mime = string(attachment.content_type);
    if (mime.startsWith("image/")) {
      images.push(url); parts.push({ kind: "image", source: url, mimeType: mime, sourceName: string(attachment.filename) || null });
    } else if (mime === "voice" || mime.startsWith("audio/")) {
      const audio = string(attachment.voice_wav_url) || url;
      audioSources.push(audio); parts.push({ kind: "audio", source: audio });
    } else {
      remoteAttachments.push({ source: url, sourceName: string(attachment.filename) || "附件", mimeType: mime, kind: mime.startsWith("video/") ? "video" : "file" });
      specialSegments.push({ type: "attachment", summary: JSON.stringify({ url, name: string(attachment.filename), mimeType: mime }) });
      parts.push({ kind: "special", segmentType: "attachment", summary: JSON.stringify({ url, name: string(attachment.filename), mimeType: mime }) });
    }
  }
  const mentions = (Array.isArray(event.mentions) ? event.mentions : []).map((item) => {
    const user = record(item); return string(user.member_openid) || string(user.user_openid) || string(user.id);
  }).filter(Boolean);
  const ext = record(event.message_scene).ext;
  const reference = (Array.isArray(ext) ? ext : []).find((item): item is string => typeof item === "string" && item.startsWith("ref_msg_idx="));
  return {
    permit, messageId, timestampMs,
    message: {
      source: "qq_official", sourceRef: { platform: "qq_official", connectionId: registry.connectionId, messageId }, replyContext: permit,
      channelId: registry.connectionId, externalUserId, chatType: group ? "group" : "private", userId: externalUserId,
      ...(group ? { groupId: targetId } : {}), senderName: string(author.username) || externalUserId,
      text, contentParts: parts, remoteAttachments, images, audioSources, audioIds: [], emojiSources: [], imageIds: [], emojiIds: [],
      forwardIds: [], replyMessageId: reference?.slice("ref_msg_idx=".length) || null,
      mentionUserIds: mentions, mentionedAll: text.includes("<@all>"), isAtMentioned: group,
      ...(specialSegments.length ? { specialSegments } : {})
    }
  };
}
