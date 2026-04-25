import type { ChatFileRecord } from "#services/workspace/types.ts";
import { chatFileCaptionToDerivedObservation, type DerivedObservation } from "#llm/derivations/derivedObservation.ts";

export interface WorkspaceFileView {
  file_id: string;
  file_ref: string;
  kind: ChatFileRecord["kind"];
  chat_file_path: string;
  source_name: string;
  mime_type: string;
  size_bytes: number;
  origin: ChatFileRecord["origin"];
  created_at_ms: number;
  caption: string | null;
  caption_status: ChatFileRecord["captionStatus"];
  caption_updated_at_ms: number | null;
  caption_model_ref: string | null;
  caption_error: string | null;
  caption_observation: DerivedObservation;
}

export function mapWorkspaceFileToView(file: ChatFileRecord): WorkspaceFileView {
  return {
    file_id: file.fileId,
    file_ref: file.fileRef,
    kind: file.kind,
    chat_file_path: file.chatFilePath,
    source_name: file.sourceName,
    mime_type: file.mimeType,
    size_bytes: file.sizeBytes,
    origin: file.origin,
    created_at_ms: file.createdAtMs,
    caption: file.caption,
    caption_status: file.captionStatus ?? (file.caption ? "ready" : "missing"),
    caption_updated_at_ms: file.captionUpdatedAtMs ?? null,
    caption_model_ref: file.captionModelRef ?? null,
    caption_error: file.captionError ?? null,
    caption_observation: chatFileCaptionToDerivedObservation(file)
  };
}
