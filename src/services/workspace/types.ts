export type WorkspaceFileKind = "file" | "directory";

export interface WorkspaceItemStat {
  path: string;
  name: string;
  kind: WorkspaceFileKind;
  sizeBytes: number;
  updatedAtMs: number;
}

export interface WorkspaceListResult {
  root: string;
  path: string;
  items: WorkspaceItemStat[];
}

export interface WorkspaceFileReadResult {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
}

export interface WorkspaceFileContentResult {
  path: string;
  contentType: string;
  buffer: Buffer;
}

export type WorkspaceWriteMode = "overwrite" | "append" | "create";

export interface WorkspaceWriteResult {
  path: string;
  bytesWritten: number;
  updatedAtMs: number;
}

export interface WorkspaceMoveResult {
  fromPath: string;
  toPath: string;
}

export interface WorkspaceDeleteResult {
  path: string;
  deleted: boolean;
}

export interface WorkspacePatchResult {
  path: string;
  updatedAtMs: number;
  hunksApplied: number;
}

export type WorkspaceStoredFileKind = "image" | "animated_image" | "video" | "audio" | "file";
export type WorkspaceStoredFileOrigin =
  | "chat_message"
  | "browser_download"
  | "browser_screenshot"
  | "comfy_generated"
  | "workspace_import"
  | "user_upload";

export interface WorkspaceStoredFileRecord {
  fileId: string;
  fileRef: string;
  kind: WorkspaceStoredFileKind;
  origin: WorkspaceStoredFileOrigin;
  workspacePath: string;
  sourceName: string;
  mimeType: string;
  sizeBytes: number;
  createdAtMs: number;
  sourceContext: Record<string, string | number | boolean | null>;
  caption: string | null;
}

export interface ChatAttachment {
  fileId: string;
  kind: WorkspaceStoredFileKind;
  source: "chat_message" | "web_upload" | "browser" | "workspace";
  sourceName: string | null;
  mimeType: string | null;
  semanticKind?: "image" | "emoji";
}
