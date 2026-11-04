/** Captures object identity as well as epoch so deleting and recreating a session cannot revive a late write. */
export function captureSessionMutationGuard(
  sessions: { getSession(sessionId: string): { mutationEpoch: number } },
  sessionId: string
): () => boolean {
  const expected = sessions.getSession(sessionId);
  const epoch = expected.mutationEpoch;
  return () => {
    try {
      const current = sessions.getSession(sessionId);
      return current === expected && current.mutationEpoch === epoch;
    } catch { return false; }
  };
}
