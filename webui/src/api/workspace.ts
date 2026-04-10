import { api } from "./client";

export interface WorkspaceItem {
  path: string;
  name: string;
  kind: "file" | "directory";
  sizeBytes: number;
  updatedAtMs: number;
}

export interface WorkspaceListResult {
  root: string;
  path: string;
  items: WorkspaceItem[];
}

export interface WorkspaceFilePreview {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
}

export interface WorkspaceStoredFileSummary {
  fileId: string;
  fileRef: string;
  kind: "image" | "animated_image" | "video" | "audio" | "file";
  origin: string;
  workspacePath: string;
  sourceName: string;
  mimeType: string;
  sizeBytes: number;
  createdAtMs: number;
  sourceContext: Record<string, string | number | boolean | null>;
  caption: string | null;
}

export interface WorkspaceStoredFileDetail {
  file: WorkspaceStoredFileSummary;
}

export const workspaceApi = {
  listItems(path = "."): Promise<WorkspaceListResult> {
    return api.get(`/api/workspace/items?path=${encodeURIComponent(path)}`);
  },
  statItem(path = "."): Promise<WorkspaceItem> {
    return api.get(`/api/workspace/stat?path=${encodeURIComponent(path)}`);
  },
  readFile(path: string, range?: { startLine?: number; endLine?: number }): Promise<WorkspaceFilePreview> {
    const params = new URLSearchParams({ path });
    if (range?.startLine != null) {
      params.set("startLine", String(range.startLine));
    }
    if (range?.endLine != null) {
      params.set("endLine", String(range.endLine));
    }
    return api.get(`/api/workspace/file?${params.toString()}`);
  },
  getFileContentUrl(path: string): string {
    return `/api/workspace/content?path=${encodeURIComponent(path)}`;
  },
  getSendFileContentUrl(path: string): string {
    return `/api/workspace/send-content?path=${encodeURIComponent(path)}`;
  },
  listFiles(): Promise<{ files: WorkspaceStoredFileSummary[] }> {
    return api.get("/api/workspace/files");
  },
  getFile(fileId: string): Promise<WorkspaceStoredFileDetail> {
    return api.get(`/api/workspace/files/${encodeURIComponent(fileId)}`);
  },
  getFileContentUrlById(fileId: string): string {
    return `/api/workspace/files/${encodeURIComponent(fileId)}/content`;
  }
};
