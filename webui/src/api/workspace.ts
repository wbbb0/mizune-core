import { api } from "./client";
import type { ContentSafetyAuditView, DerivedObservation } from "./types";
import type { FileWorkspaceClient, LocalFileItem, LocalFileListResult, LocalFilePreview } from "@workbench-kit/vue-file-workspace";

export type { FileWorkspaceClient, LocalFileItem, LocalFileListResult, LocalFilePreview } from "@workbench-kit/vue-file-workspace";

export interface ChatFileSummary {
  fileId: string;
  fileRef: string;
  kind: "image" | "animated_image" | "video" | "audio" | "file";
  origin: string;
  chatFilePath: string;
  sourceName: string;
  mimeType: string;
  sizeBytes: number;
  createdAtMs: number;
  sourceContext: Record<string, string | number | boolean | null>;
  caption: string | null;
  captionStatus?: "missing" | "queued" | "ready" | "failed";
  captionUpdatedAtMs: number | null;
  captionModelRef: string | null;
  captionError: string | null;
  captionObservation: DerivedObservation;
  contentSafety: ContentSafetyAuditView | null;
}

export interface ChatFileDetail {
  file: ChatFileSummary;
}

export const fileApi: FileWorkspaceClient & {
  listLocalItems(path?: string): Promise<LocalFileListResult>;
  statLocalItem(path?: string): Promise<LocalFileItem>;
  readLocalFile(path: string, range?: { startLine?: number; endLine?: number }): Promise<LocalFilePreview>;
  getLocalFileContentUrl(path: string): string;
  getLocalSendFileContentUrl(path: string): string;
  listChatFiles(): Promise<{ files: ChatFileSummary[] }>;
  getChatFile(fileId: string): Promise<ChatFileDetail>;
  getChatFileContentUrlById(fileId: string): string;
} = {
  listItems(path = "."): Promise<LocalFileListResult> {
    return api.get(`/api/local-files/items?path=${encodeURIComponent(path)}`);
  },
  listLocalItems(path = "."): Promise<LocalFileListResult> {
    return api.get(`/api/local-files/items?path=${encodeURIComponent(path)}`);
  },
  statLocalItem(path = "."): Promise<LocalFileItem> {
    return api.get(`/api/local-files/stat?path=${encodeURIComponent(path)}`);
  },
  readLocalFile(path: string, range?: { startLine?: number; endLine?: number }): Promise<LocalFilePreview> {
    const params = new URLSearchParams({ path });
    if (range?.startLine != null) {
      params.set("startLine", String(range.startLine));
    }
    if (range?.endLine != null) {
      params.set("endLine", String(range.endLine));
    }
    return api.get(`/api/local-files/file?${params.toString()}`);
  },
  readFile(path: string, range?: { startLine?: number; endLine?: number }): Promise<LocalFilePreview> {
    const params = new URLSearchParams({ path });
    if (range?.startLine != null) {
      params.set("startLine", String(range.startLine));
    }
    if (range?.endLine != null) {
      params.set("endLine", String(range.endLine));
    }
    return api.get(`/api/local-files/file?${params.toString()}`);
  },
  getLocalFileContentUrl(path: string): string {
    return `/api/local-files/content?path=${encodeURIComponent(path)}`;
  },
  getContentUrl(path: string): string {
    return `/api/local-files/content?path=${encodeURIComponent(path)}`;
  },
  getLocalSendFileContentUrl(path: string): string {
    return `/api/local-files/send-content?path=${encodeURIComponent(path)}`;
  },
  listChatFiles(): Promise<{ files: ChatFileSummary[] }> {
    return api.get("/api/chat-files");
  },
  getChatFile(fileId: string): Promise<ChatFileDetail> {
    return api.get(`/api/chat-files/${encodeURIComponent(fileId)}`);
  },
  getChatFileContentUrlById(fileId: string): string {
    return `/api/chat-files/${encodeURIComponent(fileId)}/content`;
  }
};
