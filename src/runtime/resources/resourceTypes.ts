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
  protocolVersion: 2;
  persistentState: string;
  currentGoal: string | null;
  modelRefs: string[];
  allowAutonomyPolicyChange: boolean;
  allowProgramDeployment: boolean;
  lastEventSequence: number;
  binding: MinecraftActorBindingState;
}

export type MinecraftActorDesiredState = "open" | "closed";
export type MinecraftActorProvisionStatus =
  | "pending"
  | "running"
  | "ready"
  | "needs_attention"
  | "retry_wait"
  | "failed"
  | "stopped";
export type MinecraftActorProvisionPhase =
  | "validating_target"
  | "probing_server"
  | "resolving_template"
  | "allocating"
  | "starting_daemon"
  | "waiting_daemon"
  | "starting_client"
  | "waiting_bridge"
  | "connecting_server"
  | "ready";

export interface MinecraftActorBindingState {
  serverAddress: string;
  serverHost: string;
  serverPort: number;
  serverKey: string;
  templateId: string;
  templateFingerprint: string;
  identityRef: string;
  backend: "simulation" | "neoforge";
  desiredState: MinecraftActorDesiredState;
  provisionStatus: MinecraftActorProvisionStatus;
  provisionPhase: MinecraftActorProvisionPhase;
  failureCode: string | null;
  failureMessage: string | null;
  retryAtMs: number | null;
  attemptId: string | null;
}

export type MinecraftRuntimeIncarnationStatus = "starting" | "running" | "stopping" | "stopped" | "failed";

export interface MinecraftRuntimeIncarnationRecord {
  runtimeInstanceId: string;
  resourceId: string;
  attemptId: string;
  status: MinecraftRuntimeIncarnationStatus;
  daemonPid: number | null;
  daemonStartTicks: string | null;
  clientPid: number | null;
  clientStartTicks: string | null;
  processGroupId: number | null;
  bootId: string;
  socketPath: string;
  gameDirectory: string;
  tokenFile: string;
  bridgePort: number | null;
  startedAtMs: number;
  stoppedAtMs: number | null;
  exitReason: string | null;
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
  protocol_version: 2;
  current_goal: string | null;
  allow_autonomy_policy_change: boolean;
  allow_program_deployment: boolean;
  last_event_sequence: number;
  server_address: string;
  backend: MinecraftActorBindingState["backend"];
  provision_status: MinecraftActorProvisionStatus;
  provision_phase: MinecraftActorProvisionPhase;
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
