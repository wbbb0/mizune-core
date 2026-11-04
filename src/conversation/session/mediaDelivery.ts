import type { SessionState } from "./sessionTypes.ts";
import { freezeTranscriptItem } from "./immutableTranscript.ts";
import { z } from "zod";

export const mediaDeliveryStatusSchema = z.enum(["queued", "sending", "accepted", "failed", "cancelled", "unknown"]);
export const mediaDeliveryErrorSchema = z.object({
  stage: z.enum(["prepare", "upload", "message"]),
  code: z.string().regex(/^[a-zA-Z0-9_:-]{1,80}$/),
  message: z.string().max(300)
});
export type MediaDeliveryStatus = z.infer<typeof mediaDeliveryStatusSchema>;
export type MediaDeliveryError = z.infer<typeof mediaDeliveryErrorSchema>;
export interface MediaDeliveryPatch {
  deliveryStatus: MediaDeliveryStatus;
  messageId?: string | number | null;
  deliveryError?: MediaDeliveryError;
}
export function isTerminalMediaDelivery(status: MediaDeliveryStatus): boolean {
  return status !== "queued" && status !== "sending";
}
export function patchMediaDeliveryState(session: SessionState, deliveryId: string, patch: MediaDeliveryPatch): boolean {
  const index = session.internalTranscript.findIndex(item => item.id === deliveryId && item.kind === "outbound_media_message");
  const item = session.internalTranscript[index];
  if (!item || item.kind !== "outbound_media_message" || isTerminalMediaDelivery(item.deliveryStatus)) return false;
  const allowed = item.deliveryStatus === "queued" ? ["sending", "cancelled", "failed"] : ["accepted", "failed", "cancelled", "unknown"];
  if (!allowed.includes(patch.deliveryStatus)) return false;
  if (patch.deliveryError) mediaDeliveryErrorSchema.parse(patch.deliveryError);
  const next = { ...item, ...patch, deliveryUpdatedAtMs: Date.now() };
  if (patch.deliveryStatus === "accepted") delete next.deliveryError;
  session.internalTranscript[index] = freezeTranscriptItem(next);
  return true;
}
