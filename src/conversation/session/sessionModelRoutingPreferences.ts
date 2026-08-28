import { z } from "zod";

export const sessionModelRoutingPreferencesSchema = z.object({
  selfUpgradeEnabled: z.boolean().default(true)
});

export type SessionModelRoutingPreferences = z.infer<typeof sessionModelRoutingPreferencesSchema>;

export function createDefaultSessionModelRoutingPreferences(): SessionModelRoutingPreferences {
  return {
    selfUpgradeEnabled: true
  };
}

export function cloneSessionModelRoutingPreferences(
  preferences: SessionModelRoutingPreferences
): SessionModelRoutingPreferences {
  return {
    selfUpgradeEnabled: preferences.selfUpgradeEnabled
  };
}
