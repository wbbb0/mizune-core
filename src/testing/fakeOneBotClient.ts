import { EventEmitter } from "node:events";
import type {
  OneBotApiResponse,
  OneBotFriendItem,
  OneBotGroupItem,
  OneBotGroupMemberInfo,
  OneBotGroupMemberItem,
  OneBotHistoryMessage,
  OneBotLoginInfo,
  OneBotMessageEvent,
  OneBotMessageSegment,
  OneBotRequestEvent,
  OneBotRetrievedMessage,
  OneBotSendResult
} from "#services/onebot/types.ts";
import type { OneBotClient } from "#services/onebot/onebotClient.ts";

export interface FakeOneBotSentMessage {
  messageId: number;
  userId?: string;
  groupId?: string;
  text: string;
  segments: OneBotMessageSegment[];
  createdAt: number;
}

export interface FakeOneBotClientOptions {
  selfId: string;
  selfName?: string;
}

export class FakeOneBotClient extends EventEmitter {
  private nextMessageId = 1;
  private started = false;
  readonly sentMessages: FakeOneBotSentMessage[] = [];

  constructor(private readonly options: FakeOneBotClientOptions) {
    super();
  }

  asOneBotClient(): OneBotClient {
    return this as unknown as OneBotClient;
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
    this.removeAllListeners("message");
    this.removeAllListeners("request");
  }

  async reloadConfig(): Promise<void> {
  }

  pushPrivateText(input: {
    userId: string;
    text: string;
    senderName?: string;
  }): OneBotMessageEvent {
    return this.pushMessage({
      chatType: "private",
      userId: input.userId,
      text: input.text,
      ...(input.senderName ? { senderName: input.senderName } : {})
    });
  }

  async pushPrivateTextAndWait(input: {
    userId: string;
    text: string;
    senderName?: string;
  }): Promise<OneBotMessageEvent> {
    return this.pushMessageAndWait({
      chatType: "private",
      userId: input.userId,
      text: input.text,
      ...(input.senderName ? { senderName: input.senderName } : {})
    });
  }

  pushGroupText(input: {
    groupId: string;
    userId: string;
    text: string;
    senderName?: string;
    atSelf?: boolean;
  }): OneBotMessageEvent {
    return this.pushMessage({
      chatType: "group",
      groupId: input.groupId,
      userId: input.userId,
      text: input.text,
      ...(input.senderName ? { senderName: input.senderName } : {}),
      atSelf: input.atSelf === true
    });
  }

  async pushGroupTextAndWait(input: {
    groupId: string;
    userId: string;
    text: string;
    senderName?: string;
    atSelf?: boolean;
  }): Promise<OneBotMessageEvent> {
    return this.pushMessageAndWait({
      chatType: "group",
      groupId: input.groupId,
      userId: input.userId,
      text: input.text,
      ...(input.senderName ? { senderName: input.senderName } : {}),
      atSelf: input.atSelf === true
    });
  }

  pushMessage(input: {
    chatType: "private" | "group";
    userId: string;
    text: string;
    groupId?: string;
    senderName?: string;
    atSelf?: boolean;
  }): OneBotMessageEvent {
    const event = this.createMessageEvent(input);
    this.emit("message", event);
    return event;
  }

  async pushMessageAndWait(input: {
    chatType: "private" | "group";
    userId: string;
    text: string;
    groupId?: string;
    senderName?: string;
    atSelf?: boolean;
  }): Promise<OneBotMessageEvent> {
    const event = this.createMessageEvent(input);
    await Promise.all(this.listeners("message").map(async (listener) => {
      await (listener as (event: OneBotMessageEvent) => unknown).call(this, event);
    }));
    return event;
  }

  private createMessageEvent(input: {
    chatType: "private" | "group";
    userId: string;
    text: string;
    groupId?: string;
    senderName?: string;
    atSelf?: boolean;
  }): OneBotMessageEvent {
    if (!this.started) {
      throw new Error("FakeOneBotClient is not started");
    }
    const segments: OneBotMessageSegment[] = [];
    if (input.chatType === "group" && input.atSelf) {
      segments.push({
        type: "at",
        data: {
          qq: this.options.selfId
        }
      });
    }
    segments.push({
      type: "text",
      data: {
        text: input.text
      }
    });
    const event: OneBotMessageEvent = {
      post_type: "message",
      message_type: input.chatType,
      sub_type: "normal",
      message_id: this.nextMessageId++,
      user_id: Number(input.userId),
      ...(input.groupId ? { group_id: Number(input.groupId) } : {}),
      message: segments,
      raw_message: `${input.chatType === "group" && input.atSelf ? `[CQ:at,qq=${this.options.selfId}]` : ""}${input.text}`,
      sender: {
        user_id: Number(input.userId),
        nickname: input.senderName ?? input.userId
      },
      self_id: Number(this.options.selfId),
      time: Math.floor(Date.now() / 1000)
    };
    return event;
  }

  pushRequest(event: OneBotRequestEvent): void {
    this.emit("request", event);
  }

  async sendText(target: { userId?: string; groupId?: string; text: string }): Promise<OneBotSendResult> {
    return this.sendMessage({
      ...target,
      message: [{ type: "text", data: { text: target.text } }]
    });
  }

  async sendMessage(target: {
    userId?: string;
    groupId?: string;
    message: OneBotMessageSegment[];
  }): Promise<OneBotSendResult> {
    const messageId = this.nextMessageId++;
    const sent: FakeOneBotSentMessage = {
      messageId,
      ...(target.userId ? { userId: target.userId } : {}),
      ...(target.groupId ? { groupId: target.groupId } : {}),
      text: formatSegmentsAsText(target.message),
      segments: target.message,
      createdAt: Date.now()
    };
    this.sentMessages.push(sent);
    this.emit("sent", sent);
    return {
      status: "ok",
      retcode: 0,
      data: {
        message_id: messageId
      }
    };
  }

  async deleteMessage(messageId: number): Promise<OneBotApiResponse> {
    this.emit("deleted", messageId);
    return { status: "ok", retcode: 0, data: null };
  }

  async setTyping(): Promise<boolean> {
    return true;
  }

  async getFriendList(): Promise<OneBotFriendItem[]> {
    return [];
  }

  async getGroupList(): Promise<OneBotGroupItem[]> {
    return [];
  }

  async getGroupInfo(groupId: string): Promise<OneBotGroupItem | null> {
    return {
      group_id: Number(groupId),
      group_name: `CLI 群 ${groupId}`
    };
  }

  async getGroupMemberInfo(groupId: string, userId: string): Promise<OneBotGroupMemberInfo | null> {
    return {
      group_id: Number(groupId),
      user_id: Number(userId),
      nickname: userId
    };
  }

  async getGroupMemberList(groupId: string): Promise<OneBotGroupMemberItem[]> {
    return [{
      group_id: Number(groupId),
      user_id: Number(this.options.selfId),
      nickname: this.options.selfName ?? "CLI Bot",
      role: "member"
    }];
  }

  async getGroupAnnouncements(): Promise<[]> {
    return [];
  }

  async getLoginInfo(): Promise<OneBotLoginInfo> {
    return {
      user_id: Number(this.options.selfId),
      nickname: this.options.selfName ?? "CLI Bot"
    };
  }

  async getPrivateMessageHistory(): Promise<OneBotHistoryMessage[]> {
    return [];
  }

  async getGroupMessageHistory(): Promise<OneBotHistoryMessage[]> {
    return [];
  }

  async getForwardMessage(): Promise<unknown[]> {
    return [];
  }

  async getMessage(messageId: string): Promise<OneBotRetrievedMessage> {
    return {
      message_id: Number(messageId),
      message: [],
      raw_message: "",
      sender: {},
      time: null
    };
  }

  async getImage(file: string): Promise<{ file: string | null; url: string | null }> {
    return { file, url: null };
  }

  async getRecord(file: string): Promise<{ file: string | null; url: string | null }> {
    return { file, url: null };
  }

  async setFriendAddRequest(): Promise<OneBotApiResponse> {
    return { status: "ok", retcode: 0, data: null };
  }

  async setGroupAddRequest(): Promise<OneBotApiResponse> {
    return { status: "ok", retcode: 0, data: null };
  }
}

function formatSegmentsAsText(segments: OneBotMessageSegment[]): string {
  return segments.map((segment) => {
    if (segment.type === "text") {
      return String(segment.data.text ?? "");
    }
    if (segment.type === "at") {
      return `@${String(segment.data.qq ?? "")}`;
    }
    return `[${segment.type}]`;
  }).join("");
}
