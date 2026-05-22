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
  }
};

export function openShellSocket(sessionId: string): WebSocket {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(`${protocol}//${window.location.host}/api/shell/sessions/${encodeURIComponent(sessionId)}/attach`);
}
