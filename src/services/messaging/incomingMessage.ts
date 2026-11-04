import type { ChatAttachment } from "#services/workspace/types.ts";
import type { MessageContentPart } from "#messages/contentParts.ts";
import type { OneBotMessageEvent, OneBotMessageFileSummary, OneBotSpecialSegmentSummary } from "#services/onebot/types.ts";
import type { QqReplyPermit } from "../qqOfficial/types.ts";

export type MessageReplyContext = QqReplyPermit;

export interface ParsedIncomingMessage {
  actorAuthorization?: import("./toolActorAuthorization.ts").ToolActorAuthorization;
  source?: "onebot" | "qq_official" | "web";
  contextOnly?: boolean;
  activationUpgrade?: boolean;
  sourceRef?: { platform: "qq_official"; connectionId: string; messageId: string; referenceId?: string };
  replyContext?: MessageReplyContext;
  channelId?: string;
  externalUserId?: string;
  chatType: "private" | "group";
  userId: string;
  groupId?: string;
  senderName: string;
  text: string;
  contentParts?: MessageContentPart[];
  images: string[];
  audioSources: string[];
  audioIds: string[];
  emojiSources: string[];
  imageIds: string[];
  emojiIds: string[];
  attachments?: ChatAttachment[];
  remoteAttachments?: Array<{ source: string; sourceName: string; mimeType: string; kind: "file" | "video" }>;
  messageFiles?: OneBotMessageFileSummary[];
  specialSegments?: OneBotSpecialSegmentSummary[];
  forwardIds: string[];
  replyMessageId: string | null;
  mentionUserIds: string[];
  mentionedAll: boolean;
  isAtMentioned: boolean;
  rawEvent?: OneBotMessageEvent | undefined;
}
