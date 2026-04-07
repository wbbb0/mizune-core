import { s, type Infer } from "#data/schema/index.ts";

export const browserPageRecoveryStateSchema = s.object({
  requestedUrl: s.string(),
  resolvedUrl: s.string(),
  backend: s.enum(["playwright"] as const),
  title: s.union([s.string(), s.literal(null)]).default(null),
  profileId: s.union([s.string(), s.literal(null)]).default(null)
}).strict();

export const shellSessionRecoveryStateSchema = s.object({
  command: s.string(),
  cwd: s.string(),
  shell: s.string(),
  tty: s.boolean(),
  login: s.boolean()
}).strict();

export const runtimeResourceRecordSchema = s.object({
  resourceId: s.string().trim().nonempty(),
  kind: s.enum(["browser_page", "shell_session"] as const),
  status: s.enum(["active", "expired", "closed", "unrecoverable"] as const),
  ownerSessionId: s.union([s.string().trim().nonempty(), s.literal(null)]).default(null),
  title: s.union([s.string(), s.literal(null)]).default(null),
  description: s.union([s.string(), s.literal(null)]).default(null),
  summary: s.string(),
  createdAtMs: s.number().int().min(0),
  lastAccessedAtMs: s.number().int().min(0),
  expiresAtMs: s.union([s.number().int().min(0), s.literal(null)]).default(null),
  browserPage: browserPageRecoveryStateSchema.optional(),
  shellSession: shellSessionRecoveryStateSchema.optional()
}).strict();

export const runtimeResourceFileSchema = s.object({
  resources: s.array(runtimeResourceRecordSchema).default([])
}).strict();

export type RuntimeResourceFile = Infer<typeof runtimeResourceFileSchema>;
