import { s, type Infer } from "#data/schema/index.ts";

export const scheduledJobScheduleSchema = s.discriminatedUnion("kind", [
  s.object({
    kind: s.literal("delay"),
    delayMs: s.number().int().positive()
  }).strict(),
  s.object({
    kind: s.literal("at"),
    runAtMs: s.number().int().min(0),
    tz: s.string().trim().nonempty()
  }).strict(),
  s.object({
    kind: s.literal("cron"),
    expr: s.string().trim().nonempty(),
    tz: s.string().trim().nonempty()
  }).strict()
]);

export const scheduledJobRecordSchema = s.object({
  id: s.string().trim().nonempty(),
  name: s.string().trim().nonempty(),
  enabled: s.boolean(),
  createdAtMs: s.number().int().min(0),
  updatedAtMs: s.number().int().min(0),
  schedule: scheduledJobScheduleSchema,
  instruction: s.string().trim().nonempty(),
  targets: s.array(s.object({
    sessionId: s.string().trim().nonempty()
  }).strict()).min(1),
  state: s.object({
    nextRunAtMs: s.union([s.number().int().min(0), s.literal(null)]).default(null),
    lastRunAtMs: s.union([s.number().int().min(0), s.literal(null)]).default(null),
    lastRunStatus: s.union([s.enum(["ok", "error", "running"] as const), s.literal(null)]).default(null),
    lastDurationMs: s.union([s.number().int().min(0), s.literal(null)]).default(null),
    lastError: s.union([s.string(), s.literal(null)]).default(null),
    consecutiveErrors: s.number().int().min(0)
  }).strict()
}).strict();

export const scheduledJobFileSchema = s.object({
  version: s.literal(1),
  jobs: s.array(scheduledJobRecordSchema).default([])
}).strict();

export type ScheduledJobRecord = Infer<typeof scheduledJobRecordSchema>;
export type ScheduledJobFile = Infer<typeof scheduledJobFileSchema>;
