import type { ChatAttachment, ChatFileKind } from "#types/chatContracts.ts";

export type LocalFileKind = "file" | "directory";

export interface LocalFileItemStat {
  path: string;
  name: string;
  kind: LocalFileKind;
  sizeBytes: number;
  updatedAtMs: number;
}

export interface LocalFileListResult {
  root: string;
  path: string;
  items: LocalFileItemStat[];
  truncated: boolean;
}

export interface LocalFileReadResult {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
}

export interface LocalFileContentResult {
  path: string;
  contentType: string;
  buffer: Buffer;
}

export type LocalFileWriteMode = "overwrite" | "append" | "create";

export interface LocalFileWriteResult {
  path: string;
  bytesWritten: number;
  updatedAtMs: number;
}

export interface LocalFileMoveResult {
  fromPath: string;
  toPath: string;
}

export interface LocalFileDeleteResult {
  path: string;
  deleted: boolean;
}

export interface LocalFilePatchResult {
  path: string;
  updatedAtMs: number;
  hunksApplied: number;
}

export interface LocalFileSearchItem {
  path: string;
  name: string;
  kind: LocalFileKind;
}

export interface LocalFileSearchResult {
  root: string;
  path: string;
  query: string;
  items: LocalFileSearchItem[];
  truncated: boolean;
}

export interface LocalFileTextMatch {
  path: string;
  line: number;
  text: string;
}

export interface LocalFileFindTextResult {
  root: string;
  path: string;
  query: string;
  matches: LocalFileTextMatch[];
  truncated: boolean;
}

export type { ChatAttachment, ChatFileKind };
export type ChatFileCaptionStatus = "missing" | "queued" | "ready" | "failed";
export type ChatFileOrigin =
  | "chat_message"
  | "browser_download"
  | "browser_screenshot"
  | "comfy_generated"
  | "local_file_import"
  | "user_upload";

export interface ChatFileRecord {
  fileId: string;
  fileRef: string;
  kind: ChatFileKind;
  origin: ChatFileOrigin;
  chatFilePath: string;
  sourceName: string;
  mimeType: string;
  sizeBytes: number;
  createdAtMs: number;
  sourceContext: Record<string, string | number | boolean | null>;
  caption: string | null;
  captionStatus?: ChatFileCaptionStatus | undefined;
  captionUpdatedAtMs?: number | undefined;
  captionModelRef?: string | null | undefined;
  captionError?: string | null | undefined;
}
