import { s, type Infer } from "#data/schema/index.ts";

export const comfyTaskResultFileSchema = s.object({
  filename: s.string().trim().nonempty(),
  subfolder: s.string(),
  type: s.string().trim().nonempty()
}).strict();

export const comfyTaskRecordSchema = s.object({
  id: s.string().trim().nonempty(),
  sessionId: s.string().trim().nonempty(),
  userId: s.string().trim().nonempty(),
  templateId: s.string().trim().nonempty(),
  workflowFile: s.string().trim().nonempty(),
  workflowSnapshot: s.object({}).passthrough(),
  positivePrompt: s.string(),
  aspectRatio: s.string().trim().nonempty(),
  resolvedWidth: s.number().int().positive(),
  resolvedHeight: s.number().int().positive(),
  comfyPromptId: s.string().trim().nonempty(),
  status: s.enum(["queued", "running", "succeeded", "failed", "notified"] as const),
  resultAssetIds: s.array(s.string().trim().nonempty()).default([]),
  resultFiles: s.array(comfyTaskResultFileSchema).default([]),
  autoIterationIndex: s.number().int().min(0).default(0),
  maxAutoIterations: s.number().int().min(0).default(1),
  lastError: s.union([s.string(), s.literal(null)]).default(null),
  createdAtMs: s.number().int().min(0),
  updatedAtMs: s.number().int().min(0),
  startedAtMs: s.union([s.number().int().min(0), s.literal(null)]).default(null),
  finishedAtMs: s.union([s.number().int().min(0), s.literal(null)]).default(null)
}).strict();

export const comfyTaskFileSchema = s.object({
  version: s.literal(1),
  tasks: s.array(comfyTaskRecordSchema).default([])
}).strict();

export type ComfyTaskRecord = Infer<typeof comfyTaskRecordSchema>;
export type ComfyTaskFile = Infer<typeof comfyTaskFileSchema>;
