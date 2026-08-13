import { api } from "@/api/client";

export type MinecraftActorResourceStatus = "active" | "expired" | "closed" | "unrecoverable";
export type MinecraftActorLoopPhase = "idle" | "queued" | "deciding" | "paused" | "error" | "closed" | "unavailable";
export type MinecraftActorRequestStatus = "queued" | "running" | "completed" | "failed" | "interrupted" | "cancelled";

export interface MinecraftActorSummary {
  resourceId: string;
  actorId: string;
  title: string | null;
  description: string | null;
  summary: string;
  resourceStatus: MinecraftActorResourceStatus;
  currentGoal: string | null;
  loopPhase: MinecraftActorLoopPhase;
  revision: number;
  lastError: string | null;
  updatedAtMs: number;
}

export interface MinecraftActorRequest {
  resourceId: string;
  requestId: string;
  instruction: string;
  constraints: string | null;
  priority: "normal" | "high";
  status: MinecraftActorRequestStatus;
  decisionId: string | null;
  resultSummary: string | null;
  error: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  startedAtMs: number | null;
  completedAtMs: number | null;
}

export interface MinecraftActorJournalEvent {
  eventId: number;
  resourceId: string;
  eventType: string;
  severity: "debug" | "info" | "warning" | "critical";
  actorRevision: number;
  requestId: string | null;
  decisionId: string | null;
  payload: unknown;
  occurredAtMs: number;
}

export interface MinecraftActorRuntimeSnapshot {
  protocolVersion: 1;
  actorId: string;
  actorRevision: number;
  observationRevision: number;
  self: {
    position: { x: number; y: number; z: number };
    health: number;
    food: number;
    connected: boolean;
  };
  activeBehavior: {
    runId: string;
    capability: string;
    status: "running" | "succeeded" | "failed" | "cancelled";
    startedAtMs: number;
    completedAtMs: number | null;
    arguments: Record<string, unknown>;
    reason: string | null;
  } | null;
  activeTask: {
    taskId: string;
    kind: string;
    source: "control" | "autonomy";
    priority: "low" | "normal" | "high";
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    createdAtMs: number;
    startedAtMs: number | null;
    completedAtMs: number | null;
    behaviorRunId: string | null;
    arguments: Record<string, unknown>;
    reason: string | null;
  } | null;
  queuedTaskCount: number;
  autonomyPolicy: {
    enabled: boolean;
    idleDelayMs: number;
    collectItems: boolean;
    explore: boolean;
    combatHostiles: boolean;
    exploreRadius: number;
    combatStopHealth: number;
  };
}

export interface MinecraftActorDetail extends MinecraftActorSummary {
  persistentState: string;
  runtimeSnapshot: MinecraftActorRuntimeSnapshot | null;
  runtimeError: string | null;
  requests: MinecraftActorRequest[];
  timeline: MinecraftActorJournalEvent[];
  capabilities: {
    canRequest: boolean;
    canInterrupt: boolean;
    canClose: boolean;
    canEmergencyStop: false;
    programValidationSupported: boolean;
    programExecutionSupported: false;
  };
}

export type MinecraftActorStreamEvent =
  | { type: "actor_snapshot" | "actor_reset"; id: number; actor: MinecraftActorDetail }
  | { type: "actor_resume"; id: number; actor: MinecraftActorSummary; requests: MinecraftActorRequest[] }
  | { type: "actor_event"; id: number; event: MinecraftActorJournalEvent }
  | { type: "actor_reconnect"; id: number; reason: "initial_buffer_overflow" }
  | {
      type: "actor_terminal";
      id: number;
      resourceId: string;
      resourceStatus: Exclude<MinecraftActorResourceStatus, "active">;
    };

export const minecraftActorsApi = {
  list(): Promise<{ actors: MinecraftActorSummary[] }> {
    return api.get("/api/minecraft/actors");
  },

  detail(resourceId: string): Promise<{ actor: MinecraftActorDetail }> {
    return api.get(`/api/minecraft/actors/${encodeURIComponent(resourceId)}`);
  },

  request(resourceId: string, input: {
    instruction: string;
    constraints?: string | null;
    priority?: "normal" | "high";
    expectedRevision: number;
    idempotencyKey: string;
  }): Promise<{ ok: true; replayed: boolean; request: MinecraftActorRequest; revision: number }> {
    const { idempotencyKey, ...body } = input;
    return api.postWithHeaders(
      `/api/minecraft/actors/${encodeURIComponent(resourceId)}/requests`,
      body,
      { "Idempotency-Key": idempotencyKey }
    );
  },

  interrupt(resourceId: string, input: { expectedRevision: number; reason?: string }) {
    return api.post<{ ok: true; interrupted: boolean; revision: number }>(
      `/api/minecraft/actors/${encodeURIComponent(resourceId)}/interrupt`,
      input
    );
  },

  close(resourceId: string, input: { expectedRevision: number; reason?: string }) {
    return api.post<{ ok: true }>(`/api/minecraft/actors/${encodeURIComponent(resourceId)}/close`, input);
  },

  openStream(resourceId: string, after: number | null): EventSource {
    const query = after === null ? "" : `?after=${encodeURIComponent(String(after))}`;
    return api.sse(`/api/minecraft/actors/${encodeURIComponent(resourceId)}/stream${query}`);
  }
};
