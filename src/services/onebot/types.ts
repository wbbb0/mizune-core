import type { ChatAttachment } from "#services/workspace/types.ts";

export interface OneBotMessageSegment {
  type: string;
  data: Record<string, unknown>;
}

export interface OneBotSender {
  user_id: number;
  nickname?: string;
  card?: string;
  sex?: string;
  age?: number;
  role?: string;
}

export interface OneBotMessageEvent {
  post_type: "message";
  message_type: "private" | "group";
  sub_type: string;
  message_id: number;
  user_id: number;
  group_id?: number;
  message: OneBotMessageSegment[];
  raw_message: string;
  sender: OneBotSender;
  self_id: number;
  time: number;
  font?: number;
}

export interface OneBotRetrievedMessage {
  message_id: number | null;
  real_id?: number | null;
  message_type?: string | null;
  sub_type?: string | null;
  user_id?: number | null;
  group_id?: number | null;
  message: OneBotMessageSegment[];
  raw_message?: string;
  sender?: Record<string, unknown>;
  time?: number | null;
  font?: number | null;
}

export interface OneBotNoticeEvent {
  post_type: "notice";
  notice_type: string;
  sub_type?: string;
  self_id: number;
  time: number;
  [key: string]: unknown;
}

export interface OneBotFriendRequestEvent {
  post_type: "request";
  request_type: "friend";
  self_id: number;
  time: number;
  user_id: number;
  flag: string;
  comment?: string;
}

export interface OneBotGroupRequestEvent {
  post_type: "request";
  request_type: "group";
  self_id: number;
  time: number;
  user_id: number;
  group_id: number;
  flag: string;
  sub_type: "add" | "invite";
  comment?: string;
}

export interface OneBotMetaEvent {
  post_type: "meta_event";
  meta_event_type: "lifecycle" | "heartbeat";
  sub_type?: string;
  self_id: number;
  time: number;
  status?: Record<string, unknown>;
  interval?: number;
}

export type OneBotRequestEvent = OneBotFriendRequestEvent | OneBotGroupRequestEvent;

export type OneBotEvent = OneBotMessageEvent | OneBotNoticeEvent | OneBotRequestEvent | OneBotMetaEvent;

export interface OneBotApiResponse {
  status: string;
  retcode: number;
  data: unknown;
  message?: string;
  wording?: string;
  echo?: string;
}

export interface OneBotSendResult extends OneBotApiResponse {
  data: {
    message_id?: number | string;
    [key: string]: unknown;
  } | null;
}

export interface OneBotFriendItem {
  user_id: number;
  nickname?: string;
  remark?: string;
}

export interface OneBotGroupItem {
  group_id: number;
  group_name?: string;
  member_count?: number;
  max_member_count?: number;
}

export interface OneBotGroupMemberInfo {
  group_id: number;
  user_id: number;
  nickname?: string;
  card?: string;
  role?: string;
}

export interface ParsedIncomingMessage {
  chatType: "private" | "group";
  userId: string;
  groupId?: string;
  senderName: string;
  text: string;
  images: string[];
  audioSources: string[];
  audioIds: string[];
  emojiSources: string[];
  imageIds: string[];
  emojiIds: string[];
  attachments?: ChatAttachment[];
  forwardIds: string[];
  replyMessageId: string | null;
  mentionUserIds: string[];
  mentionedAll: boolean;
  isAtMentioned: boolean;
  rawEvent?: OneBotMessageEvent | undefined;
}
