import { z } from "zod";

export const sessionTaskStatusValues = [
  "active",
  "waiting_tool",
  "waiting_user",
  "ready_to_close",
  "suspended",
  "cancel_confirming",
  "completed",
  "canceled",
  "failed"
] as const;

const taskResourceRefSchema = z.object({
  kind: z.enum(["filesystem", "shell_session", "browser_page", "asset", "search_result", "external"]),
  id: z.string().min(1),
  locator: z.string().optional(),
  version: z.string().optional()
});

export const taskToolRefSchema = z.object({
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  summary: z.string().optional(),
  resource: taskResourceRefSchema.optional(),
  refetchHint: z.string().optional(),
  pinned: z.boolean().optional(),
  createdAtMs: z.number().int().nonnegative().optional()
});

export const sessionTaskStateSchema = z.object({
  taskId: z.string().min(1),
  status: z.enum(sessionTaskStatusValues),
  objective: z.string(),
  originalRequest: z.string().optional(),
  done: z.array(z.string()).default([]),
  next: z.array(z.string()).default([]),
  blockers: z.array(z.string()).default([]),
  importantToolRefs: z.array(taskToolRefSchema).default([]),
  createdAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
  readyToCloseAtMs: z.number().int().nonnegative().optional()
});

export const parkedTaskStateSchema = z.object({
  taskId: z.string().min(1),
  status: z.enum(sessionTaskStatusValues),
  objective: z.string(),
  summary: z.string(),
  importantToolRefs: z.array(taskToolRefSchema).default([]),
  updatedAtMs: z.number().int().nonnegative()
});

export const taskEvidenceCheckpointSchema = z.object({
  evidenceId: z.string().min(1),
  sessionId: z.string().min(1),
  taskId: z.string().min(1),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  summary: z.string(),
  resource: taskResourceRefSchema.optional(),
  replayContent: z.string().optional(),
  canonicalContent: z.string().optional(),
  canonicalTruncated: z.boolean().optional(),
  contentHash: z.string().min(1),
  pinned: z.boolean(),
  createdAtMs: z.number().int().nonnegative()
});

export const sessionTaskTrackerSchema = z.object({
  version: z.literal(1),
  primary: sessionTaskStateSchema.nullable(),
  parked: z.array(parkedTaskStateSchema).default([]),
  evidence: z.array(taskEvidenceCheckpointSchema).default([])
});

export type SessionTaskStatus = (typeof sessionTaskStatusValues)[number];
export type TaskToolRef = z.infer<typeof taskToolRefSchema>;
export type SessionTaskState = z.infer<typeof sessionTaskStateSchema>;
export type ParkedTaskState = z.infer<typeof parkedTaskStateSchema>;
export type TaskEvidenceCheckpoint = z.infer<typeof taskEvidenceCheckpointSchema>;
export type SessionTaskTracker = z.infer<typeof sessionTaskTrackerSchema>;

export function createEmptySessionTaskTracker(): SessionTaskTracker {
  return {
    version: 1,
    primary: null,
    parked: [],
    evidence: []
  };
}
