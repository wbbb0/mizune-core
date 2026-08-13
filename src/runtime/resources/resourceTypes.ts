export type RuntimeResourceKind = "browser_page" | "shell_session" | "minecraft_actor";
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

export interface MinecraftActorRecoveryState {
  actorId: string;
  transportKind: "unix_socket" | "loopback_tcp" | "in_process";
  endpoint: string;
  protocolVersion: 1;
  persistentState: string;
  currentGoal: string | null;
  modelRefs: string[];
  allowAutonomyPolicyChange: boolean;
  allowProgramDeployment: boolean;
  lastEventSequence: number;
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
  minecraftActor?: MinecraftActorRecoveryState;
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

export interface MinecraftActorResourceSummary {
  resource_id: string;
  status: RuntimeResourceStatus;
  actor_id: string;
  transport_kind: MinecraftActorRecoveryState["transportKind"];
  endpoint: string;
  protocol_version: 1;
  current_goal: string | null;
  allow_autonomy_policy_change: boolean;
  allow_program_deployment: boolean;
  last_event_sequence: number;
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
