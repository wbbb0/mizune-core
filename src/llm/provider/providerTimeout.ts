export function createProviderTimeoutController(input: {
  totalTimeoutMs: number;
  firstTokenTimeoutMs: number;
}) {
  const controller = new AbortController();
  let firstTokenPending = true;

  const abortWith = (message: string) => {
    if (!controller.signal.aborted) {
      controller.abort(new Error(message));
    }
  };

  const totalTimer = setTimeout(() => {
    abortWith(`LLM total timeout after ${input.totalTimeoutMs}ms`);
  }, input.totalTimeoutMs);

  const firstTokenTimer = setTimeout(() => {
    if (firstTokenPending) {
      abortWith(`LLM first token timeout after ${input.firstTokenTimeoutMs}ms`);
    }
  }, input.firstTokenTimeoutMs);

  return {
    controller,
    markFirstResponseReceived() {
      if (!firstTokenPending) {
        return;
      }
      firstTokenPending = false;
      clearTimeout(firstTokenTimer);
    },
    cleanup() {
      clearTimeout(totalTimer);
      clearTimeout(firstTokenTimer);
    }
  };
}

export function rethrowProviderAbortReason(signal: AbortSignal, error: unknown): never {
  if (signal.aborted && signal.reason instanceof Error) {
    throw signal.reason;
  }
  throw error instanceof Error ? error : new Error(String(error));
}
