import type { QqHttpClient } from "./httpClient.ts";
import { qqTargetPath, type QqReplyPermitRegistry } from "./replyPermit.ts";
import { QqDeliveryError, type QqDeliveryReceipt, type QqMessageResponse, type QqReplyPermit } from "./types.ts";

export type QqTextStreamState = "open" | "sealing" | "sealed" | "failed" | "closure_unknown";

export function qqReceipt(permit: QqReplyPermit, response: QqMessageResponse, acceptedText?: string): QqDeliveryReceipt {
  if (typeof response.id !== "string" || !response.id) throw new QqDeliveryError("unknown", "missing_message_id");
  const timestamp = Date.parse(response.timestamp ?? "");
  return {
    platform: "qq_official", connectionId: permit.connectionId, chatType: permit.chatType,
    targetId: permit.targetId, messageId: response.id, status: "accepted",
    timestampMs: Number.isFinite(timestamp) ? timestamp : Date.now(),
    ...(response.ext_info?.ref_idx ? { referenceId: response.ext_info.ref_idx } : {}),
    ...(acceptedText !== undefined ? { acceptedText } : {})
  };
}

/** Platform-accepted text is irreversible. Only the local pending buffer can be discarded. */
export class QqTextStream {
  private pending = "";
  private accepted = "";
  private streamId: string | null = null;
  private sequence: number | null = null;
  private index = 0;
  private tail: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closing: Promise<QqDeliveryReceipt | null> | null = null;
  private failure: unknown = null;
  private lastReceipt: QqDeliveryReceipt | null = null;
  private currentState: QqTextStreamState = "open";
  private interrupted = false;

  constructor(
    private readonly http: QqHttpClient,
    private readonly registry: QqReplyPermitRegistry,
    readonly permit: QqReplyPermit,
    private readonly options: { onAccepted?: (receipt: QqDeliveryReceipt) => void; flushIntervalMs?: number } = {}
  ) {
    if (permit.chatType !== "private") throw new QqDeliveryError("rejected", "group_stream_unsupported");
    registry.assert(permit);
  }

  get state(): QqTextStreamState { return this.currentState; }
  get receipt(): QqDeliveryReceipt | null { return this.lastReceipt; }

  append(text: string): void {
    if (this.currentState !== "open") {
      if (this.failure) throw this.failure;
      throw new QqDeliveryError("rejected", "stream_closed");
    }
    if (!text) return;
    if (this.pending.length + text.length > 1_048_576) throw new QqDeliveryError("rejected", "stream_buffer_limit");
    this.pending += text;
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.scheduleFlush(); }, this.options.flushIntervalMs ?? 150);
    }
  }

  finish(): Promise<QqDeliveryReceipt | null> { return this.close(false); }
  interrupt(): Promise<QqDeliveryReceipt | null> { return this.close(true); }

  private close(interrupt: boolean): Promise<QqDeliveryReceipt | null> {
    if (interrupt) { this.interrupted = true; this.pending = ""; }
    if (this.closing) return this.closing;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.currentState = "sealing";
    if (!interrupt) this.scheduleFlush();
    this.closing = this.tail.then(async () => {
      if (this.failure) throw this.failure;
      if (this.streamId) {
        try { await this.submit("", true); }
        catch (error) {
          this.currentState = "closure_unknown";
          throw error;
        }
      }
      this.currentState = "sealed";
      return this.lastReceipt;
    }).catch((error: unknown) => {
      if (this.currentState !== "closure_unknown") {
        this.currentState = error instanceof QqDeliveryError && error.kind === "unknown" ? "closure_unknown" : "failed";
      }
      throw error;
    });
    return this.closing;
  }

  private scheduleFlush(): void {
    this.tail = this.tail.then(async () => {
      if (this.failure || this.interrupted || !this.pending) return;
      const text = this.pending;
      this.pending = "";
      try { await this.submit(text, false); }
      catch (error) {
        this.failure = error;
        this.pending = "";
        this.currentState = error instanceof QqDeliveryError && error.kind === "unknown" ? "closure_unknown" : "failed";
      }
    });
  }

  private async submit(text: string, final: boolean): Promise<void> {
    this.registry.assert(this.permit);
    if (this.sequence == null) this.sequence = this.registry.allocate(this.permit);
    const response = await this.http.request<QqMessageResponse>("POST", `${qqTargetPath(this.permit)}/stream_messages`, {
      input_mode: "append", input_state: final ? 10 : 1,
      index: this.index, content_type: "text", content_raw: text,
      msg_id: this.permit.messageId, msg_seq: this.sequence,
      ...(this.streamId ? { stream_msg_id: this.streamId } : {})
    });
    const receipt = qqReceipt(this.permit, response, this.accepted + text);
    this.streamId = response.id;
    this.index += 1;
    this.accepted += text;
    this.lastReceipt = receipt;
    // Observer failures cannot convert an accepted platform request into a retry.
    try { this.options.onAccepted?.(receipt); } catch { /* caller persists its own projection errors */ }
  }
}
