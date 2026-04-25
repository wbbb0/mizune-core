import { createHash } from "node:crypto";
import type { StoredAudioFile } from "#audio/audioStore.ts";
import type { InternalToolResultItem, InternalTranscriptItem, SessionState } from "#conversation/session/sessionTypes.ts";
import type { ToolObservation } from "#conversation/session/toolObservation.ts";
import type { ChatFileCaptionStatus, ChatFileRecord } from "#services/workspace/types.ts";

export type DerivedObservationSourceKind = "tool_result" | "chat_file" | "audio" | "session" | "history";
export type DerivedObservationPurpose =
  | "tool_replay_compaction"
  | "image_caption"
  | "audio_transcription"
  | "session_title"
  | "history_summary";
export type DerivedObservationStatus = "missing" | "queued" | "ready" | "failed";

export interface DerivedObservation {
  sourceKind: DerivedObservationSourceKind;
  sourceId: string;
  purpose: DerivedObservationPurpose;
  status: DerivedObservationStatus;
  text: string | null;
  modelRef?: string | null;
  promptVersion?: string | undefined;
  sourceHash?: string | undefined;
  updatedAt?: number | undefined;
  error?: string | null;
}

export function imageCaptionToDerivedObservation(
  fileId: string,
  caption: string | null | undefined
): DerivedObservation {
  const text = normalizeOptionalText(caption);
  return {
    sourceKind: "chat_file",
    sourceId: fileId,
    purpose: "image_caption",
    status: text ? "ready" : "missing",
    text
  };
}

export function chatFileCaptionToDerivedObservation(file: ChatFileRecord): DerivedObservation {
  const text = normalizeOptionalText(file.caption);
  const status = resolveChatFileCaptionStatus(file, text);
  return {
    sourceKind: "chat_file",
    sourceId: file.fileId,
    purpose: "image_caption",
    status,
    text: status === "ready" ? text : null,
    modelRef: file.captionModelRef ?? null,
    sourceHash: hashStable([
      file.fileRef,
      file.kind,
      String(file.sizeBytes),
      String(file.createdAtMs)
    ].join("|")),
    ...(file.captionUpdatedAtMs !== undefined ? { updatedAt: file.captionUpdatedAtMs } : {}),
    error: file.captionError ?? null
  };
}

export function audioTranscriptionToDerivedObservation(audioFile: StoredAudioFile): DerivedObservation {
  return {
    sourceKind: "audio",
    sourceId: audioFile.id,
    purpose: "audio_transcription",
    status: audioFile.transcriptionStatus,
    text: audioFile.transcriptionStatus === "ready" ? normalizeOptionalText(audioFile.transcription) : null,
    modelRef: audioFile.transcriptionModelRef,
    updatedAt: audioFile.transcriptionUpdatedAt,
    error: audioFile.transcriptionError
  };
}

export function toolObservationToDerivedObservation(
  toolCallId: string,
  observation: ToolObservation,
  options?: {
    updatedAt?: number | undefined;
  }
): DerivedObservation {
  return {
    sourceKind: "tool_result",
    sourceId: toolCallId,
    purpose: "tool_replay_compaction",
    status: "ready",
    text: observation.summary,
    sourceHash: observation.contentHash,
    ...(options?.updatedAt !== undefined ? { updatedAt: options.updatedAt } : {})
  };
}

export function transcriptToolObservationsToDerivedObservations(
  transcript: readonly InternalTranscriptItem[]
): DerivedObservation[] {
  return transcript
    .filter((item): item is InternalToolResultItem & { observation: ToolObservation } => item.kind === "tool_result" && Boolean(item.observation))
    .map((item) => toolObservationToDerivedObservation(item.toolCallId, item.observation!, {
      updatedAt: item.timestampMs
    }));
}

export function sessionTitleToDerivedObservation(
  session: Pick<SessionState, "id" | "title" | "titleSource" | "lastActiveAt">
): DerivedObservation {
  const text = normalizeOptionalText(session.title);
  return {
    sourceKind: "session",
    sourceId: session.id,
    purpose: "session_title",
    status: text ? "ready" : "missing",
    text,
    sourceHash: text ? hashStable(`${session.titleSource ?? "unknown"}|${text}`) : undefined,
    updatedAt: session.lastActiveAt
  };
}

export function historySummaryToDerivedObservation(
  session: Pick<SessionState, "id" | "historySummary" | "lastActiveAt">
): DerivedObservation {
  const text = normalizeOptionalText(session.historySummary);
  return {
    sourceKind: "history",
    sourceId: session.id,
    purpose: "history_summary",
    status: text ? "ready" : "missing",
    text,
    sourceHash: text ? hashStable(text) : undefined,
    updatedAt: session.lastActiveAt
  };
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function resolveChatFileCaptionStatus(file: ChatFileRecord, text: string | null): ChatFileCaptionStatus {
  if (file.captionStatus === "ready" && !text) {
    return "missing";
  }
  if (file.captionStatus) {
    return file.captionStatus;
  }
  return text ? "ready" : "missing";
}

function hashStable(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
