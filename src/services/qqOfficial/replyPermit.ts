import { QqDeliveryError, type QqReplyPermit } from "./types.ts";

export interface QqReplyReservation { readonly sequence: number; }
interface ReservationState { permit: QqReplyPermit; state: "reserved" | "committed" | "released"; }
interface PermitState { permit: QqReplyPermit; nextSequence: number; used: number; }

// A permit belongs to one verified event and is never refreshed from a session's latest message.
export class QqReplyPermitRegistry {
  private readonly permits = new Map<string, PermitState>();
  private readonly reservations = new WeakMap<QqReplyReservation, ReservationState>();
  constructor(readonly connectionId: string, private readonly now: () => number = Date.now) {}

  issue(input: { chatType: "private" | "group"; targetId: string; messageId: string; timestampMs: number }): QqReplyPermit {
    this.prune();
    const key = `${input.chatType}:${input.targetId}:${input.messageId}`;
    const existing = this.permits.get(key);
    if (existing) return existing.permit;
    const receivedAtMs = Math.min(input.timestampMs, this.now());
    const permit: QqReplyPermit = Object.freeze({
      platform: "qq_official", connectionId: this.connectionId, chatType: input.chatType,
      targetId: input.targetId, messageId: input.messageId, receivedAtMs,
      // C2C docs disagree (5 vs 60 minutes); use the shorter bound until verified.
      expiresAtMs: receivedAtMs + 5 * 60_000, maxMessages: input.chatType === "group" ? 5 : 4
    });
    this.permits.set(key, { permit, nextSequence: 1, used: 0 });
    return permit;
  }

  assert(permit: QqReplyPermit): void {
    const state = this.permits.get(this.key(permit));
    if (!state || state.permit !== permit || permit.connectionId !== this.connectionId) {
      throw new QqDeliveryError("rejected", "invalid_reply_permit");
    }
    if (this.now() >= permit.expiresAtMs) throw new QqDeliveryError("rejected", "reply_permit_expired");
  }

  /** Reserve a logical slot before any expensive upload. Sequence numbers are never reused. */
  reserve(permit: QqReplyPermit): QqReplyReservation {
    this.assert(permit);
    const state = this.permits.get(this.key(permit))!;
    if (state.used >= permit.maxMessages) throw new QqDeliveryError("rejected", "reply_budget_exhausted");
    const reservation = Object.freeze({ sequence: state.nextSequence++ });
    state.used += 1;
    this.reservations.set(reservation, { permit, state: "reserved" });
    return reservation;
  }

  /** Once submission starts, even an unknown outcome keeps its slot consumed. */
  commit(permit: QqReplyPermit, reservation: QqReplyReservation): number {
    this.assert(permit);
    const state = this.reservations.get(reservation);
    if (!state || state.permit !== permit || state.state !== "reserved") throw new QqDeliveryError("rejected", "invalid_reply_reservation");
    state.state = "committed";
    return reservation.sequence;
  }

  release(permit: QqReplyPermit, reservation: QqReplyReservation): void {
    const state = this.reservations.get(reservation);
    if (!state || state.permit !== permit || state.state !== "reserved") return;
    state.state = "released";
    const current = this.permits.get(this.key(permit));
    if (current?.permit === permit) current.used -= 1;
  }

  allocate(permit: QqReplyPermit): number {
    return this.commit(permit, this.reserve(permit));
  }

  private key(permit: QqReplyPermit): string { return `${permit.chatType}:${permit.targetId}:${permit.messageId}`; }
  private prune(): void {
    for (const [key, state] of this.permits) if (this.now() >= state.permit.expiresAtMs) this.permits.delete(key);
    if (this.permits.size >= 10_000) throw new QqDeliveryError("rejected", "reply_permit_capacity");
  }
}

export function qqTargetPath(permit: QqReplyPermit): string {
  return `/v2/${permit.chatType === "group" ? "groups" : "users"}/${encodeURIComponent(permit.targetId)}`;
}
