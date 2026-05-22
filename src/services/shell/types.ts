export type ShellNotifyPolicy =
  | "none"
  | "notify_on_close"
  | "notify_on_input_and_close";

export interface ShellRunOwner {
  sessionId: string;
  userId: string;
  senderName: string;
}

export type TerminalInputPromptKind =
  | "confirmation"
  | "password"
  | "selection"
  | "text_input"
  | "unknown_prompt";

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
  lastInputPromptKind: TerminalInputPromptKind | null;
  lastInputPromptAtMs: number | null;
}

export type ShellRealtimeEvent =
  | {
      kind: "output";
      data: string;
    }
  | {
      kind: "status";
      session: ShellSession;
    };

export interface ShellRealtimeSubscription {
  session: ShellSession;
  replay: string;
  dispose: () => void;
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
  owner?: ShellRunOwner;
  notifyPolicy?: ShellNotifyPolicy;
}

export interface ShellRunResult {
  output: string;
  resourceId?: string;
  resource_id?: string;
  status: "completed" | "running" | "rejected";
  exitCode?: number | null;
  exit_code?: number | null;
  signal?: string | null;
  command?: string;
  cwd?: string;
  effectiveTimeoutMs?: number;
  effective_timeout_ms?: number;
  outputTruncated?: boolean;
  output_truncated?: boolean;
  policy?: {
    decision: "allow" | "deny";
    reason: string | null;
    warnings: string[];
  };
}

export interface ShellInteractionResult {
  output: string;
  outputTruncated: boolean;
  output_truncated: boolean;
  session: ShellSession;
}

export type ShellRuntimeEvent =
  | {
      kind: "session_closed";
      owner: ShellRunOwner;
      resourceId: string;
      command: string;
      cwd: string;
      exitCode: number | null;
      signal: string | null;
      output: string;
      outputTruncated: boolean;
    }
  | {
      kind: "input_required";
      owner: ShellRunOwner;
      resourceId: string;
      command: string;
      cwd: string;
      promptKind: TerminalInputPromptKind;
      promptText: string;
      promptSignature: string;
      detectedAtMs: number;
      outputTail: string;
    };

export type ShellRuntimeEventHandler = (event: ShellRuntimeEvent) => void | Promise<void>;
