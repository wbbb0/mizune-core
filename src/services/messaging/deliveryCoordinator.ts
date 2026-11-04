import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import { parseChatSessionIdentity } from "#conversation/session/sessionIdentity.ts";
import type { OneBotClient } from "#services/onebot/onebotClient.ts";
import { normalizeOneBotMessageId } from "#services/onebot/messageId.ts";
import type { OneBotMessageSegment } from "#services/onebot/types.ts";
import type { QqOfficialClient } from "#services/qqOfficial/client.ts";
import { QqDeliveryError, type QqDeliveryReceipt, type QqReplyPermit } from "#services/qqOfficial/types.ts";

export interface DeliveryAddress {
  sessionId: string;
  replyContext?: QqReplyPermit | undefined;
  signal?: AbortSignal | undefined;
}

export type DeliveryReference = { platform: "onebot"; messageId: number }
  | { platform: "qq_official"; connectionId: string; messageId: string };

/** All platform writes resolve their endpoint here; a reply permit never authorizes another target. */
export class DeliveryCoordinator {
  private readonly reportedFailures = new WeakSet<object>();
  constructor(private readonly oneBot: OneBotClient, private readonly official?: QqOfficialClient,
    private readonly onFailure?: (address: DeliveryAddress, status: "rejected" | "unknown") => void) {}

  private reportFailure(address: DeliveryAddress, error: unknown): void {
    if (address.signal?.aborted && !(error instanceof QqDeliveryError && error.kind === "unknown")) return;
    if (error && typeof error === "object") {
      if (this.reportedFailures.has(error)) return;
      this.reportedFailures.add(error);
    }
    try { this.onFailure?.(address, error instanceof QqDeliveryError ? error.kind : "rejected"); } catch { /* observation must not cause a retry */ }
  }

  private async run<T>(address: DeliveryAddress, send: () => Promise<T>): Promise<T> {
    try { return await send(); }
    catch (error) { this.reportFailure(address, error); throw error; }
  }

  private endpoint(address: DeliveryAddress) {
    address.signal?.throwIfAborted();
    const target = parseChatSessionIdentity(address.sessionId);
    if (!target) throw new Error("此会话没有外部消息端点。");
    return target;
  }

  private permit(address: DeliveryAddress): QqReplyPermit {
    const target = this.endpoint(address);
    const permit = address.replyContext;
    const targetId = target.kind === "group" ? target.groupId : target.userId;
    if (!this.official || !permit || target.source !== "qq_official"
      || permit.chatType !== target.kind || permit.targetId !== targetId
      || permit.connectionId !== target.channelId) {
      throw new Error("官方消息必须使用属于此连接和会话的回复授权。");
    }
    return permit;
  }

  sendText(address: DeliveryAddress, text: string): Promise<DeliveryReference | undefined> {
    return this.run(address, () => this.sendTextImpl(address, text));
  }

  private async sendTextImpl(address: DeliveryAddress, text: string): Promise<DeliveryReference | undefined> {
    const target = this.endpoint(address);
    if (target.source === "qq_official") {
      const receipt = await this.official!.sendText(this.permit(address), text);
      return { platform: "qq_official", connectionId: receipt.connectionId, messageId: receipt.messageId };
    }
    const result = await this.oneBot.sendText({ text, ...(target.kind === "group" ? { groupId: target.groupId } : { userId: target.userId }) });
    const messageId = normalizeOneBotMessageId(result.data?.message_id);
    return messageId == null ? undefined : { platform: "onebot", messageId };
  }

  sendSegments(address: DeliveryAddress, message: OneBotMessageSegment[]): Promise<DeliveryReference | undefined> {
    return this.run(address, () => this.sendSegmentsImpl(address, message));
  }

  private async sendSegmentsImpl(address: DeliveryAddress, message: OneBotMessageSegment[]): Promise<DeliveryReference | undefined> {
    const target = this.endpoint(address);
    if (target.source !== "onebot") throw new Error("此平台不接受 OneBot 消息段。");
    const result = await this.oneBot.sendMessage({ message, ...(target.kind === "group" ? { groupId: target.groupId } : { userId: target.userId }) });
    const messageId = normalizeOneBotMessageId(result.data?.message_id);
    return messageId == null ? undefined : { platform: "onebot", messageId };
  }

  sendMedia(address: DeliveryAddress, input: { filePath: string; kind: "image" | "emoji" | "audio" | "file"; name?: string | null; segments?: OneBotMessageSegment[] }): Promise<DeliveryReference | undefined> {
    return this.run(address, () => this.sendMediaImpl(address, input));
  }

  private async sendMediaImpl(address: DeliveryAddress, input: { filePath: string; kind: "image" | "emoji" | "audio" | "file"; name?: string | null; segments?: OneBotMessageSegment[] }): Promise<DeliveryReference | undefined> {
    const target = this.endpoint(address);
    if (target.source === "qq_official") {
      const permit = this.permit(address);
      const bytes = await readFile(input.filePath);
      address.signal?.throwIfAborted();
      const receipt = await this.official!.sendMedia(permit, { fileType: input.kind === "audio" ? 3 : input.kind === "file" ? 4 : 1, bytes, name: input.name?.trim() || basename(input.filePath) }, address.signal);
      return { platform: "qq_official", connectionId: receipt.connectionId, messageId: receipt.messageId };
    }
    if (input.kind === "file") {
      const result = await this.oneBot.sendFile({ filePath: input.filePath, ...(input.name != null ? { name: input.name } : {}), ...(target.kind === "group" ? { groupId: target.groupId } : { userId: target.userId }) });
      const messageId = normalizeOneBotMessageId(result.data?.message_id);
      return messageId == null ? undefined : { platform: "onebot", messageId };
    }
    const segments = input.segments ?? [{ type: input.kind === "audio" ? "record" : "image", data: { file: `base64://${(await readFile(input.filePath)).toString("base64")}` } }];
    return this.sendSegments(address, segments);
  }

  async retract(sessionId: string, messageId: number | string): Promise<void> {
    const target = this.endpoint({ sessionId });
    if (target.source === "qq_official") {
      if (!this.official || typeof messageId !== "string") throw new Error("无效官方消息引用。");
      await this.official.retract({ platform: "qq_official", connectionId: target.channelId,
        chatType: target.kind, targetId: target.kind === "group" ? target.groupId : target.userId,
        messageId, status: "accepted", timestampMs: 0 });
    } else {
      if (typeof messageId !== "number") throw new Error("无效 OneBot 消息引用。");
      await this.oneBot.deleteMessage(messageId);
    }
  }

  openTextStream(address: DeliveryAddress) {
    let native: ReturnType<QqOfficialClient["openTextStream"]>;
    try {
      const target = this.endpoint(address);
      if (target.kind !== "private") throw new Error("此会话不支持原生流式消息。");
      const permit = this.permit(address);
      native = this.official!.openTextStream(permit);
    } catch (error) { this.reportFailure(address, error); throw error; }
    return {
      get receipt(): QqDeliveryReceipt | null { return native.receipt; },
      append: (text: string) => { try { native.append(text); } catch (error) { this.reportFailure(address, error); throw error; } },
      finish: () => this.run(address, () => native.finish()),
      interrupt: () => this.run(address, () => native.interrupt())
    };
  }
}
