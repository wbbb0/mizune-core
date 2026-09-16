import { api } from "./client";

export interface WorkspaceResource {
  resource_id: string;
  kind: "workspace";
  name: string;
  ownerSessionId: string;
  ownerUserId: string;
  createdAtMs: number;
  expiresAtMs: number;
  status: "active" | "expired" | "closed";
}
export interface WorkspaceFile {
  path: string;
  name: string;
  kind: "file" | "directory";
  sizeBytes: number;
  updatedAtMs: number;
}
export interface WorkspaceText {
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
}
const base = (id: string) => `/api/workspaces/${encodeURIComponent(id)}`;
export const workspacesApi = {
  list: () => api.get<{ workspaces: WorkspaceResource[] }>("/api/workspaces"),
  files: (id: string, path: string) => api.get<{ path: string; items: WorkspaceFile[]; truncated: boolean }>(`${base(id)}/files?${new URLSearchParams({ path })}`),
  text: (id: string, path: string, startLine = 1) => api.get<WorkspaceText>(`${base(id)}/text?${new URLSearchParams({ path, startLine: String(startLine) })}`),
  contentUrl: (id: string, path: string, download = false) => `${base(id)}/content?${new URLSearchParams({ path, ...(download ? { download: "1" } : {}) })}`
};
