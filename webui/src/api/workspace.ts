import { api } from "./client";
import type { DerivedObservation } from "./types";

export interface LocalFileItem {
  path: string;
  name: string;
  kind: "file" | "directory";
  sizeBytes: number;
  updatedAtMs: number;
}

export interface LocalFileListResult {
  root: string;
  path: string;
  items: LocalFileItem[];
}

export interface LocalFilePreview {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
}

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
}

export interface ChatFileDetail {
  file: ChatFileSummary;
}

export const fileApi = {
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
  getLocalFileContentUrl(path: string): string {
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
