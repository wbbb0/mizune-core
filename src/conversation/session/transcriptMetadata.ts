import { randomUUID } from "node:crypto";
import type {
  InternalTranscriptItem,
  SessionState,
  TranscriptItemInvalidationReason
} from "./sessionTypes.ts";

export interface TranscriptItemPatch {
  reasoningContent?: string;
  invalidated?: boolean;
  invalidatedAt?: number;
  invalidationReason?: TranscriptItemInvalidationReason;
}

export function createTranscriptItemId(): string {
  return `ti_${randomUUID()}`;
}

export function createTranscriptGroupId(): string {
  return `tg_${randomUUID()}`;
}

export function ensurePendingTranscriptGroupId(session: SessionState): string {
  if (session.pendingTranscriptGroupId) {
    return session.pendingTranscriptGroupId;
  }
  session.pendingTranscriptGroupId = createTranscriptGroupId();
  return session.pendingTranscriptGroupId;
}

export function beginActiveTranscriptGroup(session: SessionState): string {
  const groupId = session.pendingTranscriptGroupId ?? createTranscriptGroupId();
  session.pendingTranscriptGroupId = null;
  session.activeTranscriptGroupId = groupId;
  return groupId;
}

export function clearActiveTranscriptGroup(session: SessionState): void {
  session.activeTranscriptGroupId = null;
}

export function clearPendingTranscriptGroup(session: SessionState): void {
  session.pendingTranscriptGroupId = null;
}

export function resolveTranscriptOutputGroupId(session: SessionState): string {
  return session.activeTranscriptGroupId
    ?? session.pendingTranscriptGroupId
    ?? createTranscriptGroupId();
}

export function normalizeTranscriptItem(
  item: InternalTranscriptItem,
  groupId: string
): InternalTranscriptItem {
  return {
    ...item,
    id: item.id ?? createTranscriptItemId(),
    groupId: item.groupId ?? groupId,
    invalidated: item.invalidated === true,
    ...(item.invalidatedAt != null ? { invalidatedAt: item.invalidatedAt } : {}),
    ...(item.invalidationReason ? { invalidationReason: item.invalidationReason } : {}),
    ...(item.deliveryRef ? { deliveryRef: item.deliveryRef } : {})
  };
}

export function getTranscriptItemId(item: InternalTranscriptItem): string {
  return item.id ?? createTranscriptItemId();
}

export function buildTranscriptItemPatch(
  previous: InternalTranscriptItem,
  current: InternalTranscriptItem
): TranscriptItemPatch | null {
  const patch: TranscriptItemPatch = {};
  const previousReasoning = "reasoningContent" in previous ? previous.reasoningContent : undefined;
  const currentReasoning = "reasoningContent" in current ? current.reasoningContent : undefined;

  if (previousReasoning !== currentReasoning && typeof currentReasoning === "string") {
    patch.reasoningContent = currentReasoning;
  }
  if ((previous.invalidated === true) !== (current.invalidated === true)) {
    patch.invalidated = current.invalidated === true;
  }
  if (previous.invalidatedAt !== current.invalidatedAt && current.invalidatedAt != null) {
    patch.invalidatedAt = current.invalidatedAt;
  }
  if (previous.invalidationReason !== current.invalidationReason && current.invalidationReason != null) {
    patch.invalidationReason = current.invalidationReason;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

export function getTranscriptDeleteMessageId(item: InternalTranscriptItem): number | null {
  if (item.deliveryRef?.platform === "onebot") {
    return item.deliveryRef.messageId;
  }
  if (item.kind === "outbound_media_message") {
    return item.messageId;
  }
  return null;
}
