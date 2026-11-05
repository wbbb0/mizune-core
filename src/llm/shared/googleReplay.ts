/** One content contains a single parallel group. Signatures stay on their original Part. */
export function canReplayGoogleParts(parts: unknown[], requireSignature = true): boolean {
  if (!parts.length || !parts.every(isGooglePart)) return false;
  const firstCall = parts.find(part => "functionCall" in part);
  return !requireSignature || !firstCall || (typeof firstCall.thoughtSignature === "string" && firstCall.thoughtSignature.length > 0);
}

export function isGooglePart(part: unknown): part is Record<string, unknown> {
  return !!part && typeof part === "object" && !Array.isArray(part);
}

/** Safety/edit projections use this marker; display-only normalization never calls it. */
export function invalidateGoogleReplay(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata || !Array.isArray(metadata.googleParts)) return metadata;
  const { googleParts: _parts, ...rest } = metadata;
  return { ...rest, googleReplayInvalidated: true };
}
