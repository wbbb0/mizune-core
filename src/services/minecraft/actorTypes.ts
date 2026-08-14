export const MINECRAFT_ACTOR_PROTOCOL_VERSION = 2 as const;

export const MINECRAFT_RUNTIME_EVENT_TYPES = [
  "program_started",
  "program_completed",
  "program_cancelled",
  "program_failed",
  "program_draft_validated",
  "program_activated",
  "decision_committed",
  "behavior_started",
  "behavior_progress",
  "behavior_completed",
  "behavior_cancelled",
  "task_submitted",
  "task_started",
  "task_completed",
  "task_cancelled",
  "chat_received",
  "autonomy_policy_changed",
  "autonomy_goal_selected",
  "action_started",
  "action_result",
  "checkpoint",
  "wake_candidate",
  "safety_interrupt",
  "diagnostic_log",
  "debug_command_received",
  "debug_command_result",
  "connection_changed",
  "snapshot_updated"
] as const;

export type MinecraftRuntimeEventType = typeof MINECRAFT_RUNTIME_EVENT_TYPES[number];

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type MinecraftEntityKind = "player" | "hostile" | "passive" | "item";
export type MinecraftBehaviorKind =
  | "go_to"
  | "follow_and_assist"
  | "interact_entity"
  | "collect_item"
  | "chat"
  | "combat";
export type MinecraftTaskKind = "go_to" | "collect_item" | "interact_entity" | "chat" | "combat";
export type MinecraftTaskPriority = "low" | "normal" | "high";

export interface MinecraftVec3 {
  x: number;
  y: number;
  z: number;
}

export interface MinecraftBlockPos {
  x: number;
  y: number;
  z: number;
}

export interface MinecraftSelfSnapshot {
  position: MinecraftVec3;
  health: number;
  food: number;
  connected: boolean;
}

export interface MinecraftBehaviorRun {
  runId: string;
  capability: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  startedAtMs: number;
  completedAtMs: number | null;
  arguments: Record<string, JsonValue>;
  reason: string | null;
}

export interface MinecraftTaskRun {
  taskId: string;
  kind: MinecraftTaskKind;
  source: "control" | "autonomy";
  priority: MinecraftTaskPriority;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  createdAtMs: number;
  startedAtMs: number | null;
  completedAtMs: number | null;
  behaviorRunId: string | null;
  arguments: Record<string, JsonValue>;
  reason: string | null;
}

export interface MinecraftAutonomyPolicy {
  enabled: boolean;
  idleDelayMs: number;
  collectItems: boolean;
  explore: boolean;
  combatHostiles: boolean;
  exploreRadius: number;
  combatStopHealth: number;
}

export interface MinecraftActorSnapshot {
  protocolVersion: typeof MINECRAFT_ACTOR_PROTOCOL_VERSION;
  actorId: string;
  actorRevision: number;
  observationRevision: number;
  controlStateToken: string;
  contextRef: string;
  self: MinecraftSelfSnapshot;
  activeBehavior: MinecraftBehaviorRun | null;
  actionLease: {
    leaseId: string;
    holderId: string;
    acquiredAtMs: number;
  } | null;
  activeTask: MinecraftTaskRun | null;
  queuedTaskCount: number;
  autonomyPolicy: MinecraftAutonomyPolicy;
}

export interface MinecraftObservationEnvelope {
  protocolVersion: typeof MINECRAFT_ACTOR_PROTOCOL_VERSION;
  actorId: string;
  actorRevision: number;
  observationRevision: number;
  controlStateToken: string;
  contextRef: string;
  observedAtMs: number;
  self: MinecraftSelfSnapshot;
  value: JsonValue;
}

export interface MinecraftDecisionContextCollection {
  available: boolean;
  truncated: boolean;
  items: Array<{
    ref: string;
    stableKey: string;
    kind: MinecraftEntityKind;
    typeId: string;
    name: string | null;
    position: MinecraftVec3;
    distance: number;
    visible: boolean;
    health: number | null;
    itemStack: { itemId: string; count: number } | null;
  }>;
}

export interface MinecraftDecisionContext {
  protocolVersion: typeof MINECRAFT_ACTOR_PROTOCOL_VERSION;
  actorId: string;
  actorRevision: number;
  observationRevision: number;
  controlStateToken: string;
  contextRef: string;
  observedAtMs: number;
  sourceCapturedAtMs: number;
  freshnessMs: number;
  self: MinecraftSelfSnapshot;
  activeWork: {
    available: boolean;
    activeBehavior: MinecraftBehaviorRun | null;
    activeTask: Omit<MinecraftTaskRun, "behaviorRunId"> | null;
    queuedTaskCount: number;
  };
  environmentSummary: {
    available: boolean;
    truncated: boolean;
    dimension: string | null;
    biome: string | null;
    gameTime: number | null;
    weather: string | null;
    lightLevel: number | null;
    hazards: string[];
    nearbyBlockIds: Array<{ blockId: string; count: number }>;
  };
  inventorySummary: {
    available: boolean;
    truncated: boolean;
    stacks: Array<{ itemId: string; count: number }>;
    usedSlots: number | null;
    capacity: number | null;
  };
  nearby: {
    players: MinecraftDecisionContextCollection;
    hostiles: MinecraftDecisionContextCollection;
    items: MinecraftDecisionContextCollection;
  };
  recentChat: {
    available: boolean;
    truncated: boolean;
    messages: Array<{
      messageId: string;
      direction: "incoming" | "outgoing";
      channel: string;
      sender: string | null;
      text: string;
      occurredAtMs: number;
    }>;
    cursor: string | null;
    gap: boolean;
  };
}

export interface MinecraftCommandResult {
  protocolVersion: typeof MINECRAFT_ACTOR_PROTOCOL_VERSION;
  commandId: string;
  idempotencyKey: string;
  ok: boolean;
  status: "accepted" | "succeeded" | "failed";
  reason: string | null;
  retryability: "none" | "after_refresh" | "after_state_change" | "never";
  actorRevision: number;
  observationRevision: number;
  value: JsonValue;
}

export interface MinecraftRuntimeEvent {
  protocolVersion: typeof MINECRAFT_ACTOR_PROTOCOL_VERSION;
  eventId: string;
  sequence: number;
  actorId: string;
  eventType: MinecraftRuntimeEventType;
  priority: "low" | "normal" | "high" | "critical";
  occurredAtMs: number;
  actorRevision: number;
  observationRevision: number;
  payload: Record<string, JsonValue>;
}

export interface MinecraftProgramMetadata {
  decisionId?: string;
  modelRef?: string;
  createdAtMs?: number;
  summary?: string;
}

export interface MinecraftProgramDocument {
  protocolVersion: typeof MINECRAFT_ACTOR_PROTOCOL_VERSION;
  programId: string;
  programVersion: number;
  guard: MinecraftControlGuard;
  provenance: MinecraftControlProvenance;
  language: "python";
  apiVersion: "mizune.mc.v1";
  entrypoint: "main";
  source: string;
  sourceHash: string;
  requiredCapabilities: string[];
  metadata: MinecraftProgramMetadata;
}

export interface MinecraftProgramDraft {
  draftId: string;
  validatedAtMs: number;
  program: MinecraftProgramDocument;
}

export interface MinecraftScriptDiagnostic {
  code: string;
  message: string;
  line: number | null;
  column: number | null;
}

export interface MinecraftProgramValidationResult {
  protocolVersion: typeof MINECRAFT_ACTOR_PROTOCOL_VERSION;
  ok: boolean;
  draft: MinecraftProgramDraft | null;
  diagnostics: MinecraftScriptDiagnostic[];
}

export interface MinecraftProgramObservation extends Omit<MinecraftObservationEnvelope, "value"> {
  value: MinecraftProgramDocument | null;
}

export type MinecraftObservationRequest =
  | { scope: "self" }
  | { scope: "environment" }
  | { scope: "inventory" }
  | { scope: "entities"; kind?: MinecraftEntityKind; radius?: number; limit?: number }
  | { scope: "player"; playerUuid: string }
  | { scope: "chat"; afterMessageId?: string; limit?: number }
  | { scope: "tasks"; includeCompleted?: boolean; limit?: number };

export interface MinecraftControlGuard {
  controlStateToken: string;
  conditionRefs: string[];
}

export interface MinecraftControlProvenance {
  contextRef: string;
}

interface MinecraftCommitBase {
  guard: MinecraftControlGuard;
  provenance: MinecraftControlProvenance;
  idempotencyKey: string;
  decisionReason: string;
}

export type MinecraftBehaviorCommand = MinecraftCommitBase & (
  | { kind: "go_to"; targetBlock: MinecraftBlockPos }
  | { kind: "follow_and_assist"; targetRef: string; followDistance: number; lostTargetWaitSeconds: number }
  | { kind: "interact_entity"; targetRef: string; interaction: "use" | "mount" | "feed" }
  | { kind: "collect_item"; targetRef: string }
  | { kind: "chat"; text: string; channel: "global" | "team" }
  | { kind: "combat"; targetRef: string; stopHealth: number }
);

export interface MinecraftTaskCommand extends MinecraftCommitBase {
  kind: MinecraftTaskKind;
  arguments: Record<string, JsonValue>;
  priority: MinecraftTaskPriority;
}

export interface MinecraftCancelBehaviorCommand {
  guard: MinecraftControlGuard;
  provenance: MinecraftControlProvenance;
  idempotencyKey: string;
  reason: string;
}

export interface MinecraftCancelTaskCommand extends MinecraftCancelBehaviorCommand {
  taskId: string;
}

export interface MinecraftSetAutonomyCommand {
  policy: MinecraftAutonomyPolicy;
  guard: MinecraftControlGuard;
  provenance: MinecraftControlProvenance;
  idempotencyKey: string;
}

export interface MinecraftActivateProgramCommand {
  draftId: string;
  guard: MinecraftControlGuard;
  provenance: MinecraftControlProvenance;
  idempotencyKey: string;
  decisionReason: string;
}
