import type { QqHttpClient } from "./httpClient.ts";
import { qqTargetPath } from "./replyPermit.ts";
import type { QqDeliveryPolicy, QqDeliverySlot } from "./deliveryPolicy.ts";
import { QqDeliveryError, type QqDeliveryReceipt, type QqMessageResponse, type QqReplyPermit } from "./types.ts";

const DEFAULT_FLUSH_INTERVAL_MS = 500;
const MIN_FLUSH_INTERVAL_MS = 300;

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
  private slot: QqDeliverySlot | null = null;
  private buffered = "";
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
    private readonly delivery: QqDeliveryPolicy,
    readonly permit: QqReplyPermit,
    private readonly options: { onAccepted?: (receipt: QqDeliveryReceipt) => void; flushIntervalMs?: number; signal?: AbortSignal | undefined } = {}
  ) {
    if (permit.chatType !== "private") throw new QqDeliveryError("rejected", "group_stream_unsupported");
    options.signal?.throwIfAborted();
    delivery.assertIdentity(permit);
  }

  get state(): QqTextStreamState { return this.currentState; }
  get receipt(): QqDeliveryReceipt | null { return this.lastReceipt; }

  append(text: string): void {
    this.options.signal?.throwIfAborted();
    if (this.currentState !== "open") {
      if (this.failure) throw this.failure;
      throw new QqDeliveryError("rejected", "stream_closed");
    }
    if (!text) return;
    if (this.pending.length + this.buffered.length + text.length > 1_048_576) throw new QqDeliveryError("rejected", "stream_buffer_limit");
    this.pending += text;
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.scheduleFlush(); }, Math.max(MIN_FLUSH_INTERVAL_MS, this.options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS));
    }
  }

  finish(): Promise<QqDeliveryReceipt | null> { return this.close(false); }
  interrupt(): Promise<QqDeliveryReceipt | null> { return this.close(true); }

  private close(interrupt: boolean): Promise<QqDeliveryReceipt | null> {
    if (interrupt) { this.interrupted = true; this.pending = ""; this.buffered = ""; }
    if (this.closing) return this.closing;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.currentState = "sealing";
    if (!interrupt) this.scheduleFlush();
    this.closing = this.tail.then(async () => {
      if (this.failure) throw this.failure;
      if (!this.interrupted && this.slot?.mode === "proactive" && this.buffered) {
        const text = this.buffered;
        const response = await this.delivery.submit(this.permit, this.slot, { msg_type: 2, markdown: { content: text } }, this.options.signal);
        this.buffered = "";
        this.accepted = text;
        this.lastReceipt = qqReceipt(this.permit, response, text);
        try { this.options.onAccepted?.(this.lastReceipt); } catch { /* persistence must not replay a send */ }
      }
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
      try {
        this.options.signal?.throwIfAborted();
        this.slot ??= this.delivery.reserve(this.permit);
        if (this.slot.mode === "proactive") this.buffered += text;
        else await this.submit(text, false);
      }
      catch (error) {
        // A rejected first frame has no accepted prefix. Buffer once and send a regular message at close.
        // An accepted/unknown frame is irreversible and must never be replayed via another endpoint.
        if (!this.streamId && this.slot && !this.interrupted && !this.options.signal?.aborted
          && this.delivery.tryFallback(this.permit, this.slot, error)) {
          this.buffered += text;
          return;
        }
        this.failure = error;
        this.pending = "";
        this.currentState = error instanceof QqDeliveryError && error.kind === "unknown" ? "closure_unknown" : "failed";
      }
    });
  }

  private async submit(text: string, final: boolean): Promise<void> {
    // Cancellation can still seal an already accepted prefix; it never adds pending text.
    const signal = final && this.interrupted ? undefined : this.options.signal;
    signal?.throwIfAborted();
    const fields = this.delivery.replyFields(this.permit, this.slot!);
    const fullText = this.accepted + text;
    const response = await this.http.request<QqMessageResponse>("POST", `${qqTargetPath(this.permit)}/stream_messages`, {
      // Follow the official SDK's wire format: replace carries the full immutable prefix,
      // including on DONE. Local buffering stays incremental so interruption can discard it.
      input_mode: "replace", input_state: final ? 10 : 1,
      index: this.index, content_type: "markdown", content_raw: fullText,
      ...fields,
      ...(this.streamId ? { stream_msg_id: this.streamId } : {})
    }, signal);
    const receipt = qqReceipt(this.permit, response, fullText);
    this.streamId = response.id;
    this.index += 1;
    this.accepted = fullText;
    this.lastReceipt = receipt;
    // Observer failures cannot convert an accepted platform request into a retry.
    try { this.options.onAccepted?.(receipt); } catch { /* caller persists its own projection errors */ }
  }
}
