import { isPlainObject } from "#data/schema/helpers.ts";

/** File-boundary migration only; runtime schemas expose the new name exclusively. */
export function migrateRoutingPresetContextBudgets<T>(raw: T): T {
  if (!isPlainObject(raw)) return raw;
  const result = structuredClone(raw);
  for (const preset of Object.values(result)) {
    if (!isPlainObject(preset) || !isPlainObject(preset.tokenLimits)) continue;
    const limits = preset.tokenLimits;
    if (!("triggerTokens" in limits)) continue;
    if (!("contextTokens" in limits)) limits.contextTokens = limits.triggerTokens;
    delete limits.triggerTokens;
  }
  return result;
}
