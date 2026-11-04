import type { InternalTranscriptItem } from "#conversation/session/sessionTypes.ts";
import type { MessageContentPart } from "#messages/contentParts.ts";
import { walkMessageContentParts } from "#messages/contentParts.ts";
import { cachedForwardRecordRef, forwardRecordSegments } from "#messages/forwardRecords.ts";
import { trustedReferenceParts } from "./trustedReferences.ts";

/** A content fingerprint is only an address; current session visibility remains the authority. */
export function readCachedForwardRecord(transcript: readonly InternalTranscriptItem[], ref: string): Extract<MessageContentPart, { kind: "embedded_message" }> {
  if (!/^record_[a-f0-9]{32}$/.test(ref)) throw new Error("需要有效的会话记录引用");
  for (const item of transcript) for (const part of walkMessageContentParts(trustedReferenceParts(item))) {
    if (part.kind === "embedded_message" && part.relation === "forward" && !part.recordRef && cachedForwardRecordRef(part) === ref) return part;
  }
  throw new Error("转发记录不在当前会话的可见内容中，可能已被清空或排除");
}

export const FORWARD_PAGE_LIMIT = 20;

export function pageForwardRecord(parts: readonly MessageContentPart[], offset: number, limit: number) {
  const segments = forwardRecordSegments(parts);
  return { contentParts: segments.slice(offset, offset + limit), totalSegments: segments.length,
    nextOffset: offset + limit < segments.length ? offset + limit : null };
}
