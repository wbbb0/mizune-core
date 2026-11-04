import type { InternalTranscriptItem } from "#conversation/session/sessionTypes.ts";
import type { MessageContentPart } from "#messages/contentParts.ts";
import { walkMessageContentParts } from "#messages/contentParts.ts";

/** Exact native indexes are looked up only inside the already selected conversation. No remote capability is inferred. */
export function resolveLocalReferences(parts: readonly MessageContentPart[], transcript: readonly InternalTranscriptItem[]): MessageContentPart[] {
  const known = new Map<string, { senderId?: string | undefined; senderName?: string | undefined; parts: MessageContentPart[] }>();
  for (const item of transcript) {
    if (item.runtimeExcluded || (item.kind !== "user_message" && item.kind !== "user_media_message")) continue;
    const source = item.sourceRef;
    const index = source?.platform === "qq_official" ? source.referenceId : source ? String(source.messageId) : undefined;
    if (index && item.contentParts?.length) known.set(index, { senderId: item.userId, senderName: item.senderName, parts: item.contentParts });
    for (const part of walkMessageContentParts(item.contentParts)) {
      if (part.kind === "embedded_message" && part.messageId && part.parts.length) known.set(part.messageId, part);
    }
  }
  let remaining = 400;
  const bounded = (input: readonly MessageContentPart[], depth: number): MessageContentPart[] => {
    const result: MessageContentPart[] = [];
    for (const part of input) {
      if (remaining <= 0) break;
      remaining--;
      if (part.kind === "reply" && known.has(part.messageId)) {
        const cached = known.get(part.messageId)!;
        result.push({ kind: "embedded_message", relation: "reply", messageId: part.messageId,
          ...(cached.senderId ? { senderId: cached.senderId } : {}), ...(cached.senderName ? { senderName: cached.senderName } : {}),
          parts: depth < 6 ? copy(cached.parts, depth + 1) : [], ...(depth >= 6 ? { truncated: true } : {}) });
      } else if (part.kind === "embedded_message") result.push({ ...part,
        parts: depth < 6 ? bounded(part.parts, depth + 1) : [], ...(depth >= 6 ? { truncated: true } : {}) });
      else result.push(part);
    }
    return result;
  };
  const copy = (input: readonly MessageContentPart[], depth: number): MessageContentPart[] => {
    const result: MessageContentPart[] = [];
    for (const part of input) {
      if (remaining <= 0) break;
      remaining--;
      result.push(part.kind === "embedded_message" ? { ...part, parts: depth < 6 ? copy(part.parts, depth + 1) : [],
        ...(depth >= 6 ? { truncated: true } : {}) } : part);
    }
    return result;
  };
  return bounded(parts, 0);
}
