import { api } from "@/api/client";

export type ShellNotifyPolicy = "none" | "notify_on_close" | "notify_on_input_and_close";

export interface ShellSession {
  id: string;
  command: string;
  cwd: string;
  shell: string;
  login: boolean;
  tty: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  status: "running" | "closed";
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  outputTail: string;
  error: string | null;
  ownerSessionId: string | null;
  ownerUserId: string | null;
  ownerSenderName: string | null;
  notifyPolicy: ShellNotifyPolicy;
  lastOutputAtMs: number | null;
  lastInputAtMs: number | null;
  lastInputPromptKind: string | null;
  lastInputPromptAtMs: number | null;
}

export type ShellSocketMessage =
  | { kind: "hello"; session: ShellSession; replay: string }
  | { kind: "output"; data: string }
  | { kind: "status"; session: ShellSession }
  | { kind: "error"; error: string };

export interface ShellRunRequest {
  command: string;
  description?: string;
  cwd?: string;
  timeoutMs?: number;
  tty?: boolean;
  background?: boolean;
}

export type DownloadStatus = "running" | "paused" | "completed" | "failed" | "cancelled";
export type DownloadPhase = "queued" | "probing" | "transferring" | "finalizing" | "importing";

export interface DownloadTask {
  ok: true;
  resource_id: string;
  status: DownloadStatus;
  phase: DownloadPhase;
  source_url: string;
  source_name: string | null;
  origin: string;
  concurrency: number;
  downloaded_bytes: number;
  total_bytes: number | null;
  percent: number | null;
  mime_type: string | null;
  file_id: string | null;
  file_ref: string | null;
  asset_ref: string | null;
  chat_file_path: string | null;
  kind: string | null;
  size_bytes: number | null;
  error: string | null;
  retryable: boolean;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface DownloadStartRequest {
  url: string;
  sourceName?: string;
  kind?: "image" | "animated_image" | "video" | "audio" | "file";
  concurrency?: number;
  proxy?: "auto" | "direct";
}

export const runtimeResourcesApi = {
  listShellSessions(): Promise<{ sessions: ShellSession[] }> {
    return api.get("/api/shell/sessions");
  },

  runShell(request: ShellRunRequest): Promise<{ ok: true; result: unknown }> {
    return api.post("/api/shell/run", request);
  },

  closeShell(sessionId: string): Promise<{ ok: true }> {
    return api.post(`/api/shell/sessions/${encodeURIComponent(sessionId)}/close`);
  },

  signalShell(sessionId: string, signal: string): Promise<{ ok: true; session: ShellSession }> {
    return api.post(`/api/shell/sessions/${encodeURIComponent(sessionId)}/signal`, { signal });
  },

  resizeShell(sessionId: string, cols: number, rows: number): Promise<{ ok: true; session: ShellSession }> {
    return api.post(`/api/shell/sessions/${encodeURIComponent(sessionId)}/resize`, { cols, rows });
  },

  listDownloads(): Promise<{ tasks: DownloadTask[] }> {
    return api.get("/api/downloads");
  },

  startDownload(request: DownloadStartRequest): Promise<{ task: DownloadTask }> {
    return api.post("/api/downloads", request);
  },

  pauseDownload(resourceId: string): Promise<{ task: DownloadTask }> {
    return api.post(`/api/downloads/${encodeURIComponent(resourceId)}/pause`);
  },

  resumeDownload(resourceId: string): Promise<{ task: DownloadTask }> {
    return api.post(`/api/downloads/${encodeURIComponent(resourceId)}/resume`);
  },

  cancelDownload(resourceId: string): Promise<{ task: DownloadTask }> {
    return api.post(`/api/downloads/${encodeURIComponent(resourceId)}/cancel`);
  },

  removeDownload(resourceId: string): Promise<{ ok: true }> {
    return api.delete(`/api/downloads/${encodeURIComponent(resourceId)}`);
  }
};

export function openShellSocket(sessionId: string): WebSocket {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(`${protocol}//${window.location.host}/api/shell/sessions/${encodeURIComponent(sessionId)}/attach`);
}
