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
}

export interface ShellSessionResourceSummary {
  resource_id: string;
  status: "active" | "expired" | "closed" | "unrecoverable";
  command: string;
  cwd: string;
  shell: string;
  login: boolean;
  tty: boolean;
  title: string | null;
  description: string | null;
  summary: string;
  createdAtMs: number;
  lastAccessedAtMs: number;
  expiresAtMs: number | null;
}

export interface ShellRunParams {
  command: string;
  description?: string;
  cwd?: string;
  timeoutMs?: number;
  shell?: string;
  login?: boolean;
  tty?: boolean;
  background?: boolean;
}

export interface ShellRunResult {
  output: string;
  resourceId?: string;
  status: "completed" | "running";
  exitCode?: number | null;
  signal?: string | null;
}
