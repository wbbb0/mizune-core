import type { QqHttpClient } from "./httpClient.ts";
import { qqTargetPath, type QqReplyPermitRegistry, type QqReplyReservation } from "./replyPermit.ts";
import { atQqDeliveryStage, QqDeliveryError, type QqMessageResponse, type QqReplyPermit } from "./types.ts";

export interface QqDeliverySlot {
  mode: "reply" | "proactive";
  reservation?: QqReplyReservation;
  sequence?: number;
}

const localReplyLimits = new Set(["reply_permit_expired", "reply_budget_exhausted"]);
// 仅这些明确的被动回复拒绝允许切换；鉴权、去重、内容违规和网络结果未知均不重发。
const remoteReplyLimits = new Set(["304103", "40034005", "40034128"]);

/** One destination and one policy for discrete text, media, and the first stream frame. */
export class QqDeliveryPolicy {
  private proactiveAttempts: Array<{ target: string; at: number }> = [];

  constructor(
    private readonly http: QqHttpClient,
    private readonly registry: QqReplyPermitRegistry,
    private readonly options: {
      proactiveFallback: boolean;
      now?: (() => number) | undefined;
      onFallback?: ((error: QqDeliveryError) => void) | undefined;
    }
  ) {}

  assertIdentity(permit: QqReplyPermit): void { this.registry.assertIdentity(permit); }

  reserve(permit: QqReplyPermit): QqDeliverySlot {
    this.assertIdentity(permit);
    const slot: QqDeliverySlot = { mode: "reply" };
    try { slot.reservation = this.registry.reserve(permit); }
    catch (error) { if (!this.tryFallback(permit, slot, error)) throw error; }
    return slot;
  }

  release(permit: QqReplyPermit, slot: QqDeliverySlot): void {
    if (slot.reservation) this.registry.release(permit, slot.reservation);
  }

  /** The caller must not call this after any frame of a stream has been accepted. */
  tryFallback(permit: QqReplyPermit, slot: QqDeliverySlot, error: unknown): boolean {
    this.assertIdentity(permit);
    if (!this.options.proactiveFallback || slot.mode !== "reply" || !(error instanceof QqDeliveryError)
      || error.kind !== "rejected") return false;
    const eligible = error.httpStatus == null ? localReplyLimits.has(error.code)
      : error.httpStatus >= 400 && error.httpStatus < 500 && remoteReplyLimits.has(error.code);
    if (!eligible) return false;
    this.release(permit, slot);
    slot.mode = "proactive";
    try { this.options.onFallback?.(error); } catch { /* diagnostic observers cannot change delivery */ }
    return true;
  }

  replyFields(permit: QqReplyPermit, slot: QqDeliverySlot): Record<string, unknown> {
    this.assertIdentity(permit);
    if (slot.mode === "proactive") return {};
    if (slot.sequence == null) slot.sequence = this.registry.commit(permit, slot.reservation!);
    else this.registry.assert(permit);
    return { msg_id: permit.messageId, msg_seq: slot.sequence };
  }

  async submit(permit: QqReplyPermit, slot: QqDeliverySlot, body: Record<string, unknown>, signal?: AbortSignal,
    preparationStage: "upload" | "message" = "message"): Promise<QqMessageResponse> {
    let fields: Record<string, unknown>;
    try {
      signal?.throwIfAborted();
      try { fields = this.replyFields(permit, slot); }
      catch (error) {
        if (!this.tryFallback(permit, slot, error)) throw error;
        fields = {};
      }
      if (slot.mode === "proactive") this.reserveProactiveAttempt(permit);
    } catch (error) {
      this.release(permit, slot);
      throw atQqDeliveryStage(error, preparationStage);
    }
    try { return await this.http.request("POST", `${qqTargetPath(permit)}/messages`, { ...body, ...fields }, signal); }
    catch (error) {
      if (signal?.aborted || !this.tryFallback(permit, slot, error)) throw atQqDeliveryStage(error, "message");
      // tryFallback changes the slot to proactive; the second attempt can never recurse again.
      return this.submit(permit, slot, body, signal, preparationStage);
    }
  }

  private reserveProactiveAttempt(permit: QqReplyPermit): void {
    this.assertIdentity(permit);
    const now = (this.options.now ?? Date.now)();
    this.proactiveAttempts = this.proactiveAttempts.filter(attempt => now - attempt.at < 60_000);
    const target = qqTargetPath(permit);
    // 采用未认证机器人也适用的保守上限；日额度、账号权限和用户开关由平台权威裁决。
    if (this.proactiveAttempts.length >= 30 || this.proactiveAttempts.filter(attempt => attempt.target === target).length >= 20
      || this.proactiveAttempts.filter(attempt => now - attempt.at < 1000).length >= 5) {
      throw new QqDeliveryError("rejected", "proactive_rate_limited");
    }
    this.proactiveAttempts.push({ target, at: now });
  }
}
