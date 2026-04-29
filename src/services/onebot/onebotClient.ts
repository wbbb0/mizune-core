import { EventEmitter } from "node:events";
import { fetch as undiciFetch } from "undici";
import WebSocket from "ws";
import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type {
  OneBotApiResponse,
  OneBotEvent,
  OneBotFriendItem,
  OneBotMessageEvent,
  OneBotRequestEvent,
  OneBotMessageSegment,
  OneBotGroupItem,
  OneBotGroupMemberInfo,
  OneBotGroupMemberItem,
  OneBotGroupAnnouncementItem,
  OneBotHistoryMessage,
  OneBotLoginInfo,
  OneBotRetrievedMessage,
  OneBotSendResult
} from "./types.ts";
import { createOneBotTypingAdapter } from "./typingAdapter.ts";
import { normalizeOneBotMessageId } from "./messageId.ts";

const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];

function parseEvent(raw: string): OneBotEvent | null {
  try {
    return JSON.parse(raw) as OneBotEvent;
  } catch {
    return null;
  }
}

export interface OneBotClientEvents {
  message: (event: OneBotMessageEvent) => void;
  request: (event: OneBotRequestEvent) => void;
}

export class OneBotClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private stopped = false;
  private readonly typingAdapter;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger
  ) {
    super();
    this.typingAdapter = createOneBotTypingAdapter(
      this.config,
      this.logger,
      <T extends OneBotApiResponse>(endpoint: string, body: Record<string, unknown>) => this.postApi<T>(endpoint, body)
    );
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.teardownConnection();
    this.removeAllListeners();
  }

  async reloadConfig(previousConfig: AppConfig): Promise<void> {
    const wsChanged =
      previousConfig.onebot.wsUrl !== this.config.onebot.wsUrl
      || previousConfig.onebot.accessToken !== this.config.onebot.accessToken;
    if (!wsChanged || this.stopped) {
      return;
    }

    this.logger.info(
      {
        previousWsUrl: previousConfig.onebot.wsUrl,
        nextWsUrl: this.config.onebot.wsUrl
      },
      "onebot_reconnecting_after_config_reload"
    );
    this.reconnectAttempt = 0;
    this.teardownConnection();
    this.connect();
  }

  async sendText(target: { userId?: string; groupId?: string; text: string }): Promise<OneBotSendResult> {
    return this.sendMessage({
      ...target,
      message: this.buildTextMessage(target.text)
    });
  }

  async setTyping(target: {
    enabled: boolean;
    chatType: "private" | "group";
    userId: string;
    groupId?: string;
  }): Promise<boolean> {
    return this.typingAdapter.setTyping(target);
  }

  async sendMessage(target: {
    userId?: string;
    groupId?: string;
    message: OneBotMessageSegment[];
  }): Promise<OneBotSendResult> {
    const endpoint = target.groupId != null ? "send_group_msg" : "send_private_msg";
    const body = target.groupId != null
      ? { group_id: Number(target.groupId), message: target.message }
      : { user_id: Number(target.userId), message: target.message };

    this.logger.info(
      {
        endpoint,
        userId: target.userId,
        groupId: target.groupId,
        segmentCount: target.message.length
      },
      "onebot_send_started"
    );

    try {
      const payload = await this.postApi<OneBotSendResult>(endpoint, body);
      if (payload.retcode !== 0) {
        throw new Error(
          `OneBot API returned error: ${payload.retcode} ${payload.message ?? payload.wording ?? ""}`.trim()
        );
      }

      this.logger.info(
        {
          endpoint,
          userId: target.userId,
          groupId: target.groupId,
          retcode: payload.retcode
        },
        "onebot_send_succeeded"
      );

      return payload;
    } catch (error) {
      const details = error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : { message: String(error) };
      this.logger.error(
        {
          endpoint,
          userId: target.userId,
          groupId: target.groupId,
          error: details
        },
        "onebot_send_failed"
      );
      throw error;
    }
  }

  async deleteMessage(messageId: number): Promise<OneBotApiResponse> {
    this.logger.info({ messageId }, "onebot_delete_started");

    try {
      const payload = await this.postApi<OneBotApiResponse>("delete_msg", { message_id: messageId });
      if (payload.retcode !== 0) {
        throw new Error(
          `OneBot API returned error: ${payload.retcode} ${payload.message ?? payload.wording ?? ""}`.trim()
        );
      }

      this.logger.info({ messageId, retcode: payload.retcode }, "onebot_delete_succeeded");
      return payload;
    } catch (error) {
      const details = error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : { message: String(error) };
      this.logger.warn({ messageId, error: details }, "onebot_delete_failed");
      throw error;
    }
  }

  async getFriendList(): Promise<OneBotFriendItem[]> {
    const payload = await this.postApi<OneBotApiResponse>("get_friend_list", {});
    const data = Array.isArray(payload.data) ? payload.data : [];
    return data as OneBotFriendItem[];
  }

  async getGroupList(): Promise<OneBotGroupItem[]> {
    const payload = await this.postApi<OneBotApiResponse>("get_group_list", {});
    const data = Array.isArray(payload.data) ? payload.data : [];
    return data as OneBotGroupItem[];
  }

  async getGroupInfo(groupId: string): Promise<OneBotGroupItem | null> {
    const payload = await this.postApi<OneBotApiResponse>("get_group_info", {
      group_id: Number(groupId),
      no_cache: false
    });
    this.assertApiSuccess("get_group_info", payload, { groupId });
    const data = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
      ? payload.data as Record<string, unknown>
      : null;
    if (!data || typeof data.group_id !== "number") {
      return null;
    }
    return data as OneBotGroupItem;
  }

  async getGroupMemberInfo(groupId: string, userId: string): Promise<OneBotGroupMemberInfo | null> {
    const payload = await this.postApi<OneBotApiResponse>("get_group_member_info", {
      group_id: Number(groupId),
      user_id: Number(userId),
      no_cache: false
    });
    const data = payload.data && typeof payload.data === "object"
      ? payload.data as Record<string, unknown>
      : null;
    if (!data || typeof data.group_id !== "number" || typeof data.user_id !== "number") {
      return null;
    }
    return {
      group_id: data.group_id,
      user_id: data.user_id,
      ...(typeof data.nickname === "string" ? { nickname: data.nickname } : {}),
      ...(typeof data.card === "string" ? { card: data.card } : {}),
      ...(typeof data.role === "string" ? { role: data.role } : {})
    };
  }

  async getGroupMemberList(groupId: string): Promise<OneBotGroupMemberItem[]> {
    const payload = await this.postApi<OneBotApiResponse>("get_group_member_list", {
      group_id: Number(groupId)
    });
    this.assertApiSuccess("get_group_member_list", payload, { groupId });
    const data = Array.isArray(payload.data) ? payload.data : [];
    return data.filter(isRecord) as OneBotGroupMemberItem[];
  }

  async getGroupAnnouncements(groupId: string): Promise<OneBotGroupAnnouncementItem[]> {
    const payload = await this.postApi<OneBotApiResponse>("_get_group_notice", {
      group_id: Number(groupId)
    });
    this.assertApiSuccess("_get_group_notice", payload, { groupId });
    return extractArrayPayload(payload.data).filter(isRecord) as OneBotGroupAnnouncementItem[];
  }

  async getLoginInfo(): Promise<OneBotLoginInfo> {
    const payload = await this.postApi<OneBotApiResponse>("get_login_info", {});
    this.assertApiSuccess("get_login_info", payload);
    const data = isRecord(payload.data) ? payload.data : {};
    const userId = typeof data.user_id === "number" ? data.user_id : null;
    if (userId == null) {
      throw new Error("OneBot API get_login_info returned no user_id");
    }
    return {
      user_id: userId,
      ...(typeof data.nickname === "string" ? { nickname: data.nickname } : {})
    };
  }

  async getPrivateMessageHistory(input: {
    userId: string;
    count: number;
    messageSeq?: number;
  }): Promise<OneBotHistoryMessage[]> {
    const payload = await this.postApi<OneBotApiResponse>("get_friend_msg_history", {
      user_id: Number(input.userId),
      count: input.count,
      ...(input.messageSeq != null ? { message_seq: input.messageSeq } : {})
    });
    this.assertApiSuccess("get_friend_msg_history", payload, {
      userId: input.userId,
      count: input.count
    });
    return extractHistoryMessages(payload.data, "private");
  }

  async getGroupMessageHistory(input: {
    groupId: string;
    count: number;
    messageSeq?: number;
  }): Promise<OneBotHistoryMessage[]> {
    const payload = await this.postApi<OneBotApiResponse>("get_group_msg_history", {
      group_id: Number(input.groupId),
      count: input.count,
      ...(input.messageSeq != null ? { message_seq: input.messageSeq } : {})
    });
    this.assertApiSuccess("get_group_msg_history", payload, {
      groupId: input.groupId,
      count: input.count
    });
    return extractHistoryMessages(payload.data, "group");
  }

  async getForwardMessage(forwardId: string): Promise<unknown[]> {
    const payload = await this.postApi<OneBotApiResponse>("get_forward_msg", {
      id: forwardId
    });
    this.assertApiSuccess("get_forward_msg", payload, { forwardId });
    const container = payload.data;
    if (Array.isArray(container)) {
      return container as unknown[];
    }
    if (container && typeof container === "object" && Array.isArray((container as { message?: unknown }).message)) {
      return (container as { message: unknown[] }).message;
    }
    if (container && typeof container === "object" && Array.isArray((container as { messages?: unknown }).messages)) {
      return (container as { messages: unknown[] }).messages;
    }
    return [];
  }

  async getMessage(messageId: string): Promise<OneBotRetrievedMessage> {
    const payload = await this.postApi<OneBotApiResponse>("get_msg", {
      message_id: Number(messageId)
    });
    this.assertApiSuccess("get_msg", payload, { messageId });
    const data = payload.data && typeof payload.data === "object"
      ? payload.data as Record<string, unknown>
      : {};
    return {
      message_id: typeof data.message_id === "number" ? data.message_id : null,
      real_id: typeof data.real_id === "number" ? data.real_id : null,
      message_type: typeof data.message_type === "string" ? data.message_type : null,
      sub_type: typeof data.sub_type === "string" ? data.sub_type : null,
      user_id: typeof data.user_id === "number" ? data.user_id : null,
      group_id: typeof data.group_id === "number" ? data.group_id : null,
      message: Array.isArray(data.message) ? data.message as OneBotMessageSegment[] : [],
      raw_message: typeof data.raw_message === "string" ? data.raw_message : "",
      sender: data.sender && typeof data.sender === "object"
        ? data.sender as Record<string, unknown>
        : {},
      time: typeof data.time === "number" ? data.time : null,
      font: typeof data.font === "number" ? data.font : null
    };
  }

  async getImage(file: string): Promise<{ file: string | null; url: string | null }> {
    const payload = await this.postApi<OneBotApiResponse>("get_image", {
      file
    });
    const data = payload.data && typeof payload.data === "object"
      ? payload.data as Record<string, unknown>
      : {};
    const resolvedFile = String(data.file ?? "").trim();
    const resolvedUrl = String(data.url ?? "").trim();
    return {
      file: resolvedFile || null,
      url: resolvedUrl || null
    };
  }

  async getRecord(file: string, outFormat = "mp3"): Promise<{ file: string | null; url: string | null }> {
    const payload = await this.postApi<OneBotApiResponse>("get_record", {
      file,
      out_format: outFormat
    });
    const data = payload.data && typeof payload.data === "object"
      ? payload.data as Record<string, unknown>
      : {};
    const resolvedFile = String(data.file ?? "").trim();
    const resolvedUrl = String(data.url ?? "").trim();
    return {
      file: resolvedFile || null,
      url: resolvedUrl || null
    };
  }

  async setFriendAddRequest(input: { flag: string; approve: boolean; remark?: string }): Promise<OneBotApiResponse> {
    return this.postApi<OneBotApiResponse>("set_friend_add_request", {
      flag: input.flag,
      approve: input.approve,
      ...(input.remark ? { remark: input.remark } : {})
    });
  }

  async setGroupAddRequest(input: {
    flag: string;
    subType: "add" | "invite";
    approve: boolean;
    reason?: string;
  }): Promise<OneBotApiResponse> {
    return this.postApi<OneBotApiResponse>("set_group_add_request", {
      flag: input.flag,
      sub_type: input.subType,
      approve: input.approve,
      ...(input.reason ? { reason: input.reason } : {})
    });
  }

  override on<K extends keyof OneBotClientEvents>(event: K, listener: OneBotClientEvents[K]): this {
    return super.on(event, listener);
  }

  private connect() {
    const wsUrl = this.buildWsUrl();
    this.logger.info({ wsUrl: this.config.onebot.wsUrl }, "onebot_connecting");

    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempt = 0;
      this.logger.info("onebot_connected");
    });

    ws.on("message", (raw) => {
      const payload = parseEvent(raw.toString());
      if (payload == null) {
        this.logger.warn("onebot_parse_failed");
        return;
      }

      if (payload.post_type === "message") {
        this.emit("message", payload);
      } else if (payload.post_type === "request") {
        this.emit("request", payload);
      }
    });

    ws.on("error", (error) => {
      this.logger.error({ error }, "onebot_socket_error");
    });

    ws.on("close", (code) => {
      this.ws = null;
      this.logger.warn({ code }, "onebot_disconnected");

      if (!this.stopped) {
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect() {
    if (this.reconnectTimer != null) {
      return;
    }

    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempt += 1;
    this.logger.info({ delayMs: delay, attempt: this.reconnectAttempt }, "onebot_reconnect_scheduled");

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) {
        this.connect();
      }
    }, delay);
  }

  private buildWsUrl(): string {
    if (!this.config.onebot.accessToken) {
      return this.config.onebot.wsUrl;
    }

    const separator = this.config.onebot.wsUrl.includes("?") ? "&" : "?";
    return `${this.config.onebot.wsUrl}${separator}access_token=${this.config.onebot.accessToken}`;
  }

  private buildTextMessage(text: string): OneBotMessageSegment[] {
    return [{ type: "text", data: { text } }];
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };

    if (this.config.onebot.accessToken) {
      headers.Authorization = `Bearer ${this.config.onebot.accessToken}`;
    }

    return headers;
  }

  private async postApi<T extends OneBotApiResponse>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    const response = await undiciFetch(`${this.config.onebot.httpUrl}/${endpoint}`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OneBot API error: ${response.status} ${response.statusText} ${errorText}`.trim());
    }

    return (await response.json()) as T;
  }

  private assertApiSuccess(
    endpoint: string,
    payload: OneBotApiResponse,
    context?: Record<string, unknown>
  ): void {
    if (payload.retcode === 0) {
      return;
    }

    const details = [payload.message, payload.wording]
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .join(" / ");
    const meta = context && Object.keys(context).length > 0
      ? ` ${JSON.stringify(context)}`
      : "";
    throw new Error(
      `OneBot API ${endpoint} failed${meta}: ${payload.retcode}${details ? ` ${details}` : ""}`
    );
  }

  private teardownConnection(): void {
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws != null) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function extractArrayPayload(data: unknown): unknown[] {
  if (Array.isArray(data)) {
    return data;
  }
  if (!isRecord(data)) {
    return [];
  }
  for (const key of ["notices", "notice", "messages", "message", "items", "list", "data"]) {
    const value = data[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function extractHistoryMessages(data: unknown, fallbackMessageType: "private" | "group"): OneBotHistoryMessage[] {
  return extractArrayPayload(data)
    .filter(isRecord)
    .map((item) => normalizeHistoryMessage(item, fallbackMessageType))
    .filter((item): item is OneBotHistoryMessage => item != null);
}

function normalizeHistoryMessage(
  data: Record<string, unknown>,
  fallbackMessageType: "private" | "group"
): OneBotHistoryMessage | null {
  const messageId = normalizeOneBotMessageId(data.message_id);
  const message = Array.isArray(data.message) ? data.message as OneBotMessageSegment[] : [];
  const rawMessage = typeof data.raw_message === "string" ? data.raw_message : "";
  const userId = typeof data.user_id === "number" ? data.user_id : null;
  if (messageId == null || userId == null || (message.length === 0 && !rawMessage)) {
    return null;
  }

  return {
    message_id: messageId,
    real_id: typeof data.real_id === "number" ? data.real_id : null,
    message_type: typeof data.message_type === "string" ? data.message_type : fallbackMessageType,
    sub_type: typeof data.sub_type === "string" ? data.sub_type : null,
    user_id: userId,
    group_id: typeof data.group_id === "number" ? data.group_id : null,
    message,
    raw_message: rawMessage,
    sender: isRecord(data.sender) ? data.sender : {},
    time: typeof data.time === "number" ? data.time : null,
    font: typeof data.font === "number" ? data.font : null
  };
}
