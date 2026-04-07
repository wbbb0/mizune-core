import { s, type Infer } from "#data/schema/index.ts";

export const setupStateSchema = s.object({
  state: s.enum(["needs_owner", "needs_persona", "ready"] as const),
  ownerPromptSentAt: s.union([s.number().int().min(0), s.literal(null)]).default(null),
  updatedAt: s.number().int().min(0)
}).strict();

export type SetupStateRecord = Infer<typeof setupStateSchema>;
