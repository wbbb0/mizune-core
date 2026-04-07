export type RuntimeResourceKind = "browser_page" | "shell_session";
export type RuntimeResourceStatus = "active" | "expired" | "closed" | "unrecoverable";

export interface BrowserPageRecoveryState {
  requestedUrl: string;
  resolvedUrl: string;
  backend: "playwright";
  title: string | null;
  profileId: string | null;
}

export interface ShellSessionRecoveryState {
  command: string;
  cwd: string;
  shell: string;
  tty: boolean;
  login: boolean;
}

export interface RuntimeResourceRecord {
  resourceId: string;
  kind: RuntimeResourceKind;
  status: RuntimeResourceStatus;
  ownerSessionId: string | null;
  title: string | null;
  description: string | null;
  summary: string;
  createdAtMs: number;
  lastAccessedAtMs: number;
  expiresAtMs: number | null;
  browserPage?: BrowserPageRecoveryState;
  shellSession?: ShellSessionRecoveryState;
}

export interface BrowserPageResourceSummary {
  resource_id: string;
  status: RuntimeResourceStatus;
  title: string | null;
  description: string | null;
  summary: string;
  requestedUrl: string;
  resolvedUrl: string;
  backend: "playwright";
  profile_id: string | null;
  createdAtMs: number;
  lastAccessedAtMs: number;
  expiresAtMs: number | null;
}

export interface ShellSessionResourceSummary {
  resource_id: string;
  status: RuntimeResourceStatus;
  command: string;
  cwd: string;
  shell: string;
  tty: boolean;
  login: boolean;
  title: string | null;
  description: string | null;
  summary: string;
  createdAtMs: number;
  lastAccessedAtMs: number;
  expiresAtMs: number | null;
}

export interface RuntimeResourceSummary {
  resource_id: string;
  kind: RuntimeResourceKind;
  status: RuntimeResourceStatus;
  title: string | null;
  description: string | null;
  summary: string;
  createdAtMs: number;
  lastAccessedAtMs: number;
  expiresAtMs: number | null;
}
