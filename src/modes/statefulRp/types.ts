import { z } from "zod";
import { emptyCharacterSession, type CharacterSession } from "../../character/model.ts";
import { validateJson, socialStateJsonSchema, simulationJsonSchema } from "../../character/schemaCatalog.ts";
export type StatefulRpSessionState = CharacterSession;
export const statefulRpSessionStateSchema = z.object({
  revision: z.string(), initialized: z.boolean(),
  social: z.record(z.string(), z.any()), simulation: z.record(z.string(), z.any()),
  events: z.array(z.object({ id: z.string(), date: z.string(), kind: z.string(), summary: z.string() })),
  cycleConfig: z.string().nullable()
}).strict().superRefine((state, ctx) => {
  try { validateJson(socialStateJsonSchema, state.social, "session.social"); validateJson(simulationJsonSchema, state.simulation, "session.simulation"); }
  catch (error) { ctx.addIssue({ code: "custom", message: String(error) }); }
});
export function createInitialStatefulRpSessionState(_input?: { sessionId?: string; startClockIso?: string }): StatefulRpSessionState { return emptyCharacterSession(); }
