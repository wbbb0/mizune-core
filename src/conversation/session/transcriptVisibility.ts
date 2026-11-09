import type { InternalTranscriptItem } from "./sessionTypes.ts";

export type HistoryTranscriptItem = Extract<InternalTranscriptItem, {
  kind: "user_message" | "user_media_message" | "assistant_message" | "session_mode_switch" | "profile_phase_transition";
}>;

export function isTranscriptRuntimeIncluded(item: InternalTranscriptItem): boolean {
  return item.runtimeExcluded !== true;
}

export function isTranscriptLlmVisible(item: InternalTranscriptItem): boolean {
  return item.llmVisible === true && isTranscriptRuntimeIncluded(item);
}

export function isTranscriptHistoryMessage(item: InternalTranscriptItem): item is HistoryTranscriptItem {
  return item.kind === "user_message" || item.kind === "user_media_message" || item.kind === "assistant_message"
    || item.kind === "session_mode_switch" || item.kind === "profile_phase_transition";
}
