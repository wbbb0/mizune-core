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

export interface WorkspaceAssetSummary {
  assetId: string;
  kind: "image" | "animated_image" | "video" | "audio" | "file";
  origin: string;
  storagePath: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAtMs: number;
  sourceContext: Record<string, string | number | boolean | null>;
  caption: string | null;
}

export interface WorkspaceAssetDetail {
  asset: WorkspaceAssetSummary;
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
  listAssets(): Promise<{ assets: WorkspaceAssetSummary[] }> {
    return api.get("/api/workspace/assets");
  },
  getAsset(assetId: string): Promise<WorkspaceAssetDetail> {
    return api.get(`/api/workspace/assets/${encodeURIComponent(assetId)}`);
  },
  getAssetContentUrl(assetId: string): string {
    return `/api/workspace/assets/${encodeURIComponent(assetId)}/content`;
  }
};
