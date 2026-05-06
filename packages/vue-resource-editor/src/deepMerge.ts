/**
 * Deep merge `override` on top of `base`.
 * Arrays are replaced (not concatenated), matching the bot's config behaviour.
 */
export function deepMerge(base: unknown, override: unknown): unknown {
  if (override === undefined || override === null) return base;
  if (base === undefined || base === null) return override;
  if (Array.isArray(override)) return override;
  if (typeof override !== "object" || typeof base !== "object") return override;

  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, val] of Object.entries(override as Record<string, unknown>)) {
    result[key] = deepMerge(result[key], val);
  }
  return result;
}
