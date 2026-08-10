import { z } from "zod";

export const sessionPacingPreferencesSchema = z.object({
  inputDebounce: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("adaptive") }),
    z.object({ mode: z.literal("immediate") }),
    z.object({
      mode: z.literal("fixed"),
      delayMs: z.number().int().min(0).max(120_000)
    })
  ]),
  oneBotOutbound: z.enum(["humanized", "immediate"])
});

export type SessionPacingPreferences = z.infer<typeof sessionPacingPreferencesSchema>;
export type SessionInputDebouncePreference = SessionPacingPreferences["inputDebounce"];

export function createDefaultSessionPacingPreferences(
  source: "onebot" | "web"
): SessionPacingPreferences {
  return source === "web"
    ? {
        inputDebounce: { mode: "immediate" },
        oneBotOutbound: "immediate"
      }
    : {
        inputDebounce: { mode: "adaptive" },
        oneBotOutbound: "humanized"
      };
}

export function cloneSessionPacingPreferences(
  preferences: SessionPacingPreferences
): SessionPacingPreferences {
  return {
    inputDebounce: { ...preferences.inputDebounce },
    oneBotOutbound: preferences.oneBotOutbound
  };
}
