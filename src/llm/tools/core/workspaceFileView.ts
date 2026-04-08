import type { WorkspaceStoredFileRecord } from "#services/workspace/types.ts";

export interface WorkspaceFileView {
  file_id: string;
  file_ref: string;
  kind: WorkspaceStoredFileRecord["kind"];
  workspace_path: string;
  source_name: string;
  mime_type: string;
  size_bytes: number;
  origin: WorkspaceStoredFileRecord["origin"];
  created_at_ms: number;
  caption: string | null;
}

export function mapWorkspaceFileToView(file: WorkspaceStoredFileRecord): WorkspaceFileView {
  return {
    file_id: file.fileId,
    file_ref: file.fileRef,
    kind: file.kind,
    workspace_path: file.workspacePath,
    source_name: file.sourceName,
    mime_type: file.mimeType,
    size_bytes: file.sizeBytes,
    origin: file.origin,
    created_at_ms: file.createdAtMs,
    caption: file.caption
  };
}
