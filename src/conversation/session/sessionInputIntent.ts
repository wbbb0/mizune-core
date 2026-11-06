import { z } from "zod";

/** A queued configuration event carries no fabricated player dialogue. */
export const sessionInputIntentSchema = z.object({
  kind: z.literal("character_introduction"),
  draftId: z.string().min(1)
});
export type SessionInputIntent = z.infer<typeof sessionInputIntentSchema>;
