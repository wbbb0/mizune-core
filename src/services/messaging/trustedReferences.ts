import type { InternalTranscriptItem } from "#conversation/session/sessionTypes.ts";
import type { PersistedMessageContentPart } from "#messages/contentParts.ts";
import { transcriptMessageContentPartsSchema } from "#conversation/session/transcriptContract.ts";

/** Only structured native input and reference tools establish references; text resembling a ref is not authority. */
export function trustedReferenceParts(item: InternalTranscriptItem): PersistedMessageContentPart[] {
  if (item.runtimeExcluded) return [];
  if (item.kind === "user_message" || item.kind === "user_media_message") return item.contentParts ?? [];
  if (item.kind !== "tool_result" || !["view_message", "view_forward_record"].includes(item.toolName)) return [];
  try {
    const value = JSON.parse(item.canonicalContent ?? item.content) as { contentParts?: unknown };
    const parsed = transcriptMessageContentPartsSchema.safeParse(value.contentParts);
    return parsed.success ? parsed.data : [];
  } catch { return []; }
}
