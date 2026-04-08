import type { WorkspaceAssetRecord } from "#services/workspace/types.ts";

export interface WorkspaceFileView {
  file_id: string;
  file_ref: string;
  kind: WorkspaceAssetRecord["kind"];
  workspace_path: string;
  source_name: string;
  mime_type: string;
  size_bytes: number;
  origin: WorkspaceAssetRecord["origin"];
  created_at_ms: number;
  caption: string | null;
}

export function mapWorkspaceAssetToFileView(asset: WorkspaceAssetRecord): WorkspaceFileView {
  return {
    file_id: asset.assetId,
    file_ref: asset.displayName,
    kind: asset.kind,
    workspace_path: asset.storagePath,
    source_name: asset.filename,
    mime_type: asset.mimeType,
    size_bytes: asset.sizeBytes,
    origin: asset.origin,
    created_at_ms: asset.createdAtMs,
    caption: asset.caption
  };
}
