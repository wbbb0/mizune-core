import { isTerminalMediaDelivery } from "#conversation/session/mediaDelivery.ts";
import type { SessionToolRuntimeAccess } from "#conversation/session/sessionCapabilities.ts";

export const INITIAL_MEDIA_WAIT_MS = 1000;
export const MAX_MEDIA_WAIT_MS = 10000;

type DeliverySessions = Pick<SessionToolRuntimeAccess, "getMediaDelivery" | "subscribeSession">;

/** Waiting observes one delivery; timeout never aborts the queued work or the network request. */
export async function waitForMediaDelivery(sessions: DeliverySessions, sessionId: string, deliveryId: string, waitMs: number) {
  const current = () => sessions.getMediaDelivery(sessionId, deliveryId);
  const initial = current();
  if (!initial || isTerminalMediaDelivery(initial.deliveryStatus) || waitMs <= 0) return initial;
  await new Promise<void>(resolve => {
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => { clearTimeout(timer); unsubscribe(); resolve(); };
    unsubscribe = sessions.subscribeSession(sessionId, () => {
      const item = current();
      if (!item || isTerminalMediaDelivery(item.deliveryStatus)) finish();
    });
    timer = setTimeout(finish, Math.min(waitMs, MAX_MEDIA_WAIT_MS));
    const item = current();
    if (!item || isTerminalMediaDelivery(item.deliveryStatus)) finish();
  });
  return current();
}

export function mediaDeliveryResult(item: ReturnType<DeliverySessions["getMediaDelivery"]>, deliveryId: string) {
  if (!item) return { ok: false, delivery_id: deliveryId, status: "unavailable", error: "该投递不在当前会话中，可能已被清空。" };
  return { ok: item.deliveryStatus === "queued" || item.deliveryStatus === "sending" || item.deliveryStatus === "accepted",
    delivery_id: deliveryId, status: item.deliveryStatus, queued: item.deliveryStatus === "queued" || item.deliveryStatus === "sending",
    ...(item.messageId != null ? { message_id: item.messageId } : {}),
    ...(item.deliveryError ? { detail: item.deliveryError, error: item.deliveryError.message } : {}) };
}
