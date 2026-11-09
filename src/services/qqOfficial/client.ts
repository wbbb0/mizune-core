import { EventEmitter } from "node:events";
import type { Logger } from "pino";
import { QqHttpClient, type QqFetch } from "./httpClient.ts";
import { QqGateway } from "./gateway.ts";
import { QqReplyPermitRegistry } from "./replyPermit.ts";
import { decodeQqMessage, type QqOfficialIncoming, type QqInteractiveIncoming } from "./eventDecoder.ts";
import { QqTextStream, qqReceipt } from "./textStream.ts";
import { uploadQqMedia } from "./mediaUpload.ts";
import { atQqDeliveryStage } from "./types.ts";
import { QqDeliveryPolicy } from "./deliveryPolicy.ts";
import type { QqDeliveryReceipt, QqMediaInput, QqOfficialConfig, QqReplyPermit } from "./types.ts";

export class QqOfficialClient extends EventEmitter {
  readonly connectionId: string;
  readonly permits: QqReplyPermitRegistry;
  readonly http: QqHttpClient;
  private readonly delivery: QqDeliveryPolicy;
  private readonly gateway: QqGateway;
  private selfId: string | undefined;
  private readonly onIncomingEvent: ((type: string, data: unknown) => void) | undefined;
  private readonly streams = new Set<QqTextStream>();

  constructor(readonly config: QqOfficialConfig, logger: Logger, options: { fetch?: QqFetch; now?: () => number; onIncomingEvent?: (type: string, data: unknown) => void } = {}) {
    super();
    this.onIncomingEvent = options.onIncomingEvent;
    this.connectionId = `qq_official.${config.appId}`;
    this.permits = new QqReplyPermitRegistry(this.connectionId, options.now);
    this.http = new QqHttpClient(config, options.fetch, options.now);
    this.delivery = new QqDeliveryPolicy(this.http, this.permits, {
      proactiveFallback: config.proactiveFallback ?? true, now: options.now,
      onFallback: error => logger.info({ error }, "qq_official_delivery_fallback")
    });
    this.gateway = new QqGateway(this.http, logger, (type, data) => this.acceptEvent(type, data));
  }

  async start(): Promise<void> { await this.gateway.start(); }
  async stop(): Promise<void> {
    this.gateway.stop();
    this.selfId = undefined;
    await Promise.allSettled([...this.streams].map((stream) => stream.interrupt()));
    this.streams.clear();
  }

  /** Gateway dispatch entrypoint, also usable by an authenticated transport in tests. */
  acceptEvent(type: "GROUP_AT_MESSAGE_CREATE" | "C2C_MESSAGE_CREATE", data: unknown): QqInteractiveIncoming | null;
  acceptEvent(type: string, data: unknown): QqOfficialIncoming | null;
  acceptEvent(type: string, data: unknown): QqOfficialIncoming | null {
    if (type === "READY") {
      const ready = data !== null && typeof data === "object" ? data as Record<string, unknown> : {};
      const user = ready.user !== null && typeof ready.user === "object" ? ready.user as Record<string, unknown> : {};
      this.selfId = typeof user.id === "string" && user.id ? user.id : undefined;
      return null;
    }
    if (["GROUP_AT_MESSAGE_CREATE", "GROUP_MESSAGE_CREATE", "C2C_MESSAGE_CREATE"].includes(type)) {
      // The composition root controls redaction and the explicit content-logging opt-in.
      try { this.onIncomingEvent?.(type, data); } catch { /* diagnostics cannot break message ingress */ }
    }
    const incoming = decodeQqMessage(type, data, this.permits, { ...(this.config.groupContext ? { groupContext: this.config.groupContext } : {}), selfId: this.selfId });
    if (!incoming) return null;
    this.emit("message", incoming);
    return incoming;
  }

  async sendText(permit: QqReplyPermit, text: string, signal?: AbortSignal): Promise<QqDeliveryReceipt> {
    signal?.throwIfAborted();
    const slot = this.delivery.reserve(permit);
    const response = await this.delivery.submit(permit, slot, { msg_type: 0, content: text }, signal);
    return qqReceipt(permit, response, text);
  }

  async sendMedia(permit: QqReplyPermit, input: QqMediaInput, signal?: AbortSignal): Promise<QqDeliveryReceipt> {
    let reservation;
    try {
      signal?.throwIfAborted();
      reservation = this.delivery.reserve(permit);
    }
    catch (error) { throw atQqDeliveryStage(error, "upload"); }
    let fileInfo: string;
    try {
      fileInfo = await uploadQqMedia(this.http, permit, input, signal);
      signal?.throwIfAborted();
    } catch (error) {
      this.delivery.release(permit, reservation);
      throw atQqDeliveryStage(error, "upload");
    }
    try {
      const response = await this.delivery.submit(permit, reservation, { msg_type: 7, media: { file_info: fileInfo } }, signal, "upload");
      return qqReceipt(permit, response);
    } catch (error) {
      this.delivery.release(permit, reservation);
      throw error;
    }
  }

  openTextStream(permit: QqReplyPermit, options: { onAccepted?: (receipt: QqDeliveryReceipt) => void; signal?: AbortSignal | undefined } = {}): QqTextStream {
    const stream = new QqTextStream(this.http, this.delivery, permit, options);
    this.streams.add(stream);
    // Remove closed streams opportunistically without retaining callbacks or a polling timer.
    for (const existing of this.streams) if (existing.state !== "open" && existing.state !== "sealing") this.streams.delete(existing);
    return stream;
  }

  async retract(receipt: QqDeliveryReceipt): Promise<void> {
    if (receipt.connectionId !== this.connectionId) throw new Error("消息不属于当前官方 Bot 连接");
    await this.http.request("DELETE", `/v2/${receipt.chatType === "group" ? "groups" : "users"}/${encodeURIComponent(receipt.targetId)}/messages/${encodeURIComponent(receipt.messageId)}`);
  }
}
