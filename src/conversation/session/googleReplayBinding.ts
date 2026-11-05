import { createHash } from "node:crypto";
import { invalidateGoogleReplay } from "#llm/shared/googleReplay.ts";
import type { InternalTranscriptItem } from "./sessionTypes.ts";
import { isTranscriptLlmVisible, isTranscriptRuntimeIncluded } from "./sessionTranscript.ts";

const hashText = (text: string) => createHash("sha256").update(text).digest("hex");

/** A provider response can be delivered as several transcript messages. */
export function bindGoogleReplayToTranscript(metadata: Record<string, unknown>, transcript: InternalTranscriptItem[], groupId: string | undefined): Record<string, unknown> {
  if (!Array.isArray(metadata.googleParts)) return metadata;
  const sources = groupId ? transcript.filter(item => item.groupId === groupId && item.kind === "assistant_message") : [];
  if (!sources.length || sources.some(item => !item.id || !isTranscriptRuntimeIncluded(item))) return invalidateGoogleReplay(metadata)!;
  return { ...metadata, googleReplayTranscript: sources.map(item => ({ id: item.id, textHash: hashText(item.kind === "assistant_message" ? item.text : "") })) };
}

/** Hidden, compressed, edited or absent source fragments invalidate the whole signed response. */
export function projectGoogleReplayMetadata(metadata: Record<string, unknown> | undefined, transcript: InternalTranscriptItem[]): Record<string, unknown> | undefined {
  if (!metadata?.googleReplayScope || !Array.isArray(metadata.googleParts)) return metadata;
  const sources = metadata.googleReplayTranscript;
  const valid = Array.isArray(sources) && sources.length > 0 && sources.every(source => {
    if (!source || typeof source !== "object") return false;
    const item = transcript.find(item => item.id === source.id);
    return item?.kind === "assistant_message" && isTranscriptRuntimeIncluded(item) && isTranscriptLlmVisible(item) && hashText(item.text) === source.textHash;
  });
  return valid ? metadata : invalidateGoogleReplay(metadata);
}
