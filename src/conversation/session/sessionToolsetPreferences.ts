import { z } from "zod";

export const sessionToolsetOverrideSchema = z.enum(["enabled", "disabled"]);

export const sessionToolsetPreferencesSchema = z.object({
  overrides: z.record(z.string().trim().min(1), sessionToolsetOverrideSchema)
});

export type SessionToolsetOverride = z.infer<typeof sessionToolsetOverrideSchema>;
export type SessionToolsetPreferences = z.infer<typeof sessionToolsetPreferencesSchema>;

export function createDefaultSessionToolsetPreferences(): SessionToolsetPreferences {
  return { overrides: {} };
}

export function cloneSessionToolsetPreferences(
  preferences: SessionToolsetPreferences
): SessionToolsetPreferences {
  return { overrides: { ...preferences.overrides } };
}

export function resolveSessionToolsetEnabled(
  preferences: SessionToolsetPreferences,
  toolsetId: string,
  defaultEnabled: boolean
): boolean {
  const override = preferences.overrides[toolsetId];
  return override == null ? defaultEnabled : override === "enabled";
}
