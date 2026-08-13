import { z } from "zod";
import {
  MINECRAFT_ACTOR_PROTOCOL_VERSION,
  type MinecraftActorSnapshot,
  type MinecraftActivateProgramCommand,
  type MinecraftBehaviorCommand,
  type MinecraftCancelBehaviorCommand,
  type MinecraftCancelTaskCommand,
  type MinecraftCommandResult,
  type MinecraftObservationEnvelope,
  type MinecraftObservationRequest,
  type MinecraftProgramDocument,
  type MinecraftProgramObservation,
  type MinecraftProgramValidationResult,
  type MinecraftRuntimeEvent,
  type MinecraftSetAutonomyCommand,
  type MinecraftTaskCommand
} from "./actorTypes.ts";

export type MinecraftActorRpcMethod =
  | "actor.get_snapshot"
  | "observation.get"
  | "behavior.start"
  | "behavior.cancel"
  | "task.submit"
  | "task.cancel"
  | "autonomy.set_policy"
  | "program.get_active"
  | "program.validate"
  | "program.activate"
  | "events.list";

export interface MinecraftActorTransport {
  call(method: MinecraftActorRpcMethod, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

export interface MinecraftActorClient {
  getSnapshot(signal?: AbortSignal): Promise<MinecraftActorSnapshot>;
  observe(request: MinecraftObservationRequest, signal?: AbortSignal): Promise<MinecraftObservationEnvelope>;
  startBehavior(command: MinecraftBehaviorCommand, signal?: AbortSignal): Promise<MinecraftCommandResult>;
  cancelBehavior(command: MinecraftCancelBehaviorCommand, signal?: AbortSignal): Promise<MinecraftCommandResult>;
  submitTask(command: MinecraftTaskCommand, signal?: AbortSignal): Promise<MinecraftCommandResult>;
  cancelTask(command: MinecraftCancelTaskCommand, signal?: AbortSignal): Promise<MinecraftCommandResult>;
  setAutonomy(command: MinecraftSetAutonomyCommand, signal?: AbortSignal): Promise<MinecraftCommandResult>;
  getActiveProgram(signal?: AbortSignal): Promise<MinecraftProgramObservation>;
  validateProgram(
    document: MinecraftProgramDocument,
    signal?: AbortSignal
  ): Promise<MinecraftProgramValidationResult>;
  activateProgram(command: MinecraftActivateProgramCommand, signal?: AbortSignal): Promise<MinecraftCommandResult>;
  listEvents(afterSequence?: number, signal?: AbortSignal): Promise<MinecraftRuntimeEvent[]>;
}

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema)
]));

const vec3Schema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite()
}).strict();

const selfSnapshotSchema = z.object({
  position: vec3Schema,
  health: z.number().finite().nonnegative(),
  food: z.number().int().min(0).max(20),
  connected: z.boolean()
}).strict();

const behaviorRunSchema = z.object({
  runId: z.string().min(1),
  capability: z.string().min(1),
  status: z.enum(["running", "succeeded", "failed", "cancelled"]),
  startedAtMs: z.number().int().nonnegative(),
  completedAtMs: z.number().int().nonnegative().nullable(),
  arguments: z.record(z.string(), jsonValueSchema),
  reason: z.string().nullable()
}).strict();

const taskRunSchema = z.object({
  taskId: z.string().min(1),
  kind: z.enum(["go_to", "collect_item", "interact_entity", "chat", "combat"]),
  source: z.enum(["control", "autonomy"]),
  priority: z.enum(["low", "normal", "high"]),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  createdAtMs: z.number().int().nonnegative(),
  startedAtMs: z.number().int().nonnegative().nullable(),
  completedAtMs: z.number().int().nonnegative().nullable(),
  behaviorRunId: z.string().min(1).nullable(),
  arguments: z.record(z.string(), jsonValueSchema),
  reason: z.string().nullable()
}).strict();

const autonomyPolicySchema = z.object({
  enabled: z.boolean(),
  idleDelayMs: z.number().int().min(1_000).max(300_000),
  collectItems: z.boolean(),
  explore: z.boolean(),
  combatHostiles: z.boolean(),
  exploreRadius: z.number().finite().min(4).max(64),
  combatStopHealth: z.number().finite().min(2).max(18)
}).strict();

const actorSnapshotSchema = z.object({
  protocolVersion: z.literal(MINECRAFT_ACTOR_PROTOCOL_VERSION),
  actorId: z.string().min(1),
  actorRevision: z.number().int().nonnegative(),
  observationRevision: z.number().int().nonnegative(),
  self: selfSnapshotSchema,
  activeBehavior: behaviorRunSchema.nullable(),
  actionLease: z.object({
    leaseId: z.string().min(1),
    holderId: z.string().min(1),
    acquiredAtMs: z.number().int().nonnegative()
  }).strict().nullable(),
  activeTask: taskRunSchema.nullable(),
  queuedTaskCount: z.number().int().nonnegative(),
  autonomyPolicy: autonomyPolicySchema
}).strict();

const observationEnvelopeSchema = z.object({
  protocolVersion: z.literal(MINECRAFT_ACTOR_PROTOCOL_VERSION),
  actorId: z.string().min(1),
  actorRevision: z.number().int().nonnegative(),
  observationRevision: z.number().int().nonnegative(),
  observedAtMs: z.number().int().nonnegative(),
  self: selfSnapshotSchema,
  value: jsonValueSchema
}).strict();

const commandResultSchema = z.object({
  protocolVersion: z.literal(MINECRAFT_ACTOR_PROTOCOL_VERSION),
  commandId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  ok: z.boolean(),
  status: z.enum(["accepted", "succeeded", "failed"]),
  reason: z.string().nullable(),
  retryability: z.enum(["none", "after_refresh", "after_state_change", "never"]),
  actorRevision: z.number().int().nonnegative(),
  observationRevision: z.number().int().nonnegative(),
  value: jsonValueSchema
}).strict().superRefine((result, context) => {
  if (result.ok && (result.status === "failed" || result.reason !== null || result.retryability !== "none")) {
    context.addIssue({ code: "custom", message: "successful command result has contradictory fields" });
  }
  if (!result.ok && (result.status !== "failed" || !result.reason)) {
    context.addIssue({ code: "custom", message: "failed command result has contradictory fields" });
  }
});

const runtimeEventSchema = z.object({
  protocolVersion: z.literal(MINECRAFT_ACTOR_PROTOCOL_VERSION),
  eventId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  actorId: z.string().min(1),
  eventType: z.string().min(1),
  priority: z.enum(["low", "normal", "high", "critical"]),
  occurredAtMs: z.number().int().nonnegative(),
  actorRevision: z.number().int().nonnegative(),
  observationRevision: z.number().int().nonnegative(),
  payload: z.record(z.string(), jsonValueSchema)
}).strict();

const programMetadataSchema = z.object({
  decisionId: z.string().min(1).optional(),
  modelRef: z.string().min(1).optional(),
  createdAtMs: z.number().int().nonnegative().optional(),
  summary: z.string().max(4_000).optional()
}).strict();

const programDocumentSchema = z.object({
  protocolVersion: z.literal(MINECRAFT_ACTOR_PROTOCOL_VERSION),
  programId: z.string().min(1).max(128),
  programVersion: z.number().int().positive(),
  expectedActorRevision: z.number().int().nonnegative(),
  language: z.literal("python"),
  apiVersion: z.literal("mizune.mc.v1"),
  entrypoint: z.literal("main"),
  source: z.string().min(1).max(100_000),
  sourceHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  requiredCapabilities: z.array(z.string().min(1)).max(128).refine(
    values => new Set(values).size === values.length,
    "requiredCapabilities 不能重复"
  ),
  metadata: programMetadataSchema
}).strict();

const programDraftSchema = z.object({
  draftId: z.string().min(1),
  validatedAtMs: z.number().int().nonnegative(),
  program: programDocumentSchema
}).strict();

const programValidationResultSchema = z.object({
  protocolVersion: z.literal(MINECRAFT_ACTOR_PROTOCOL_VERSION),
  ok: z.boolean(),
  draft: programDraftSchema.nullable(),
  diagnostics: z.array(z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    line: z.number().int().positive().nullable(),
    column: z.number().int().nonnegative().nullable()
  }).strict())
}).strict().superRefine((result, context) => {
  if (result.ok && (result.draft === null || result.diagnostics.length > 0)) {
    context.addIssue({ code: "custom", message: "successful program validation has contradictory fields" });
  }
  if (!result.ok && result.draft !== null) {
    context.addIssue({ code: "custom", message: "failed program validation cannot include a draft" });
  }
});

const programObservationSchema = observationEnvelopeSchema.extend({
  value: programDocumentSchema.nullable()
}).strict();

export class ProtocolMinecraftActorClient implements MinecraftActorClient {
  constructor(
    private readonly actorId: string,
    private readonly transport: MinecraftActorTransport
  ) {
    if (!actorId.trim()) {
      throw new Error("Minecraft actorId 不能为空");
    }
  }

  async getSnapshot(signal?: AbortSignal): Promise<MinecraftActorSnapshot> {
    const raw = await this.call("actor.get_snapshot", {}, signal);
    return this.parseActorEnvelope(actorSnapshotSchema, raw, "actor snapshot") as MinecraftActorSnapshot;
  }

  async observe(
    request: MinecraftObservationRequest,
    signal?: AbortSignal
  ): Promise<MinecraftObservationEnvelope> {
    const raw = await this.call("observation.get", { request }, signal);
    return this.parseActorEnvelope(observationEnvelopeSchema, raw, "observation") as MinecraftObservationEnvelope;
  }

  async startBehavior(command: MinecraftBehaviorCommand, signal?: AbortSignal): Promise<MinecraftCommandResult> {
    return this.command("behavior.start", { command }, signal);
  }

  async cancelBehavior(
    command: MinecraftCancelBehaviorCommand,
    signal?: AbortSignal
  ): Promise<MinecraftCommandResult> {
    return this.command("behavior.cancel", { command }, signal);
  }

  async submitTask(command: MinecraftTaskCommand, signal?: AbortSignal): Promise<MinecraftCommandResult> {
    return this.command("task.submit", { command }, signal);
  }

  async cancelTask(command: MinecraftCancelTaskCommand, signal?: AbortSignal): Promise<MinecraftCommandResult> {
    return this.command("task.cancel", { command }, signal);
  }

  async setAutonomy(command: MinecraftSetAutonomyCommand, signal?: AbortSignal): Promise<MinecraftCommandResult> {
    return this.command("autonomy.set_policy", { command }, signal);
  }

  async getActiveProgram(signal?: AbortSignal): Promise<MinecraftProgramObservation> {
    const raw = await this.call("program.get_active", {}, signal);
    return this.parseActorEnvelope(programObservationSchema, raw, "program observation") as MinecraftProgramObservation;
  }

  async validateProgram(
    document: MinecraftProgramDocument,
    signal?: AbortSignal
  ): Promise<MinecraftProgramValidationResult> {
    const validatedDocument = programDocumentSchema.parse(document) as MinecraftProgramDocument;
    const raw = await this.call("program.validate", { document: validatedDocument }, signal);
    return programValidationResultSchema.parse(raw) as MinecraftProgramValidationResult;
  }

  async activateProgram(
    command: MinecraftActivateProgramCommand,
    signal?: AbortSignal
  ): Promise<MinecraftCommandResult> {
    return this.command("program.activate", { command }, signal);
  }

  async listEvents(afterSequence = 0, signal?: AbortSignal): Promise<MinecraftRuntimeEvent[]> {
    const raw = await this.call("events.list", { afterSequence }, signal);
    const parsed = z.array(runtimeEventSchema).parse(raw) as MinecraftRuntimeEvent[];
    for (const event of parsed) {
      this.requireActorId(event.actorId, "runtime event");
    }
    return parsed;
  }

  private async command(
    method: MinecraftActorRpcMethod,
    payload: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<MinecraftCommandResult> {
    const raw = await this.call(method, payload, signal);
    return commandResultSchema.parse(raw) as MinecraftCommandResult;
  }

  private call(
    method: MinecraftActorRpcMethod,
    payload: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    return this.transport.call(method, {
      protocolVersion: MINECRAFT_ACTOR_PROTOCOL_VERSION,
      actorId: this.actorId,
      ...payload
    }, signal);
  }

  private parseActorEnvelope(schema: z.ZodType, raw: unknown, label: string): unknown {
    const parsed = schema.parse(raw) as { actorId: string };
    this.requireActorId(parsed.actorId, label);
    return parsed;
  }

  private requireActorId(actual: string, label: string): void {
    if (actual !== this.actorId) {
      throw new Error(`${label} actorId 不匹配：期望 ${this.actorId}，实际 ${actual}`);
    }
  }
}
