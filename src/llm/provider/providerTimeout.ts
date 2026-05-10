export function createProviderTimeoutController(input: {
  totalTimeoutMs: number;
  firstTokenTimeoutMs: number;
  thinkingTimeoutMs?: number;
}) {
  const controller = new AbortController();
  let firstTokenPending = true;
  let thinkingTimer: ReturnType<typeof setTimeout> | null = null;
  let textReceived = false;

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
    markReasoningStarted() {
      if (textReceived || thinkingTimer !== null || input.thinkingTimeoutMs == null || input.thinkingTimeoutMs <= 0) {
        return;
      }
      thinkingTimer = setTimeout(() => {
        abortWith(`LLM thinking timeout after ${input.thinkingTimeoutMs}ms`);
      }, input.thinkingTimeoutMs);
    },
    markFirstTextReceived() {
      textReceived = true;
      if (thinkingTimer !== null) {
        clearTimeout(thinkingTimer);
        thinkingTimer = null;
      }
    },
    cleanup() {
      clearTimeout(totalTimer);
      clearTimeout(firstTokenTimer);
      if (thinkingTimer !== null) {
        clearTimeout(thinkingTimer);
        thinkingTimer = null;
      }
    }
  };
}

export function rethrowProviderAbortReason(signal: AbortSignal, error: unknown): never {
  if (signal.aborted && signal.reason instanceof Error) {
    throw signal.reason;
  }
  throw error instanceof Error ? error : new Error(String(error));
}
