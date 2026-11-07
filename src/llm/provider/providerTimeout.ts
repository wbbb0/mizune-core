export function createProviderTimeoutController(input: {
  totalTimeoutMs: number;
  firstTokenTimeoutMs: number;
  thinkingTimeoutMs?: number;
  abortSignal?: AbortSignal | undefined;
}) {
  const controller = new AbortController();
  let firstTokenPending = true;
  let totalTimer: ReturnType<typeof setTimeout> | null = null;
  let firstTokenTimer: ReturnType<typeof setTimeout> | null = null;
  let thinkingTimer: ReturnType<typeof setTimeout> | null = null;
  let textReceived = false;
  let disposed = false;

  const forwardAbort = () => controller.abort(input.abortSignal?.reason);
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    if (totalTimer !== null) clearTimeout(totalTimer);
    if (firstTokenTimer !== null) clearTimeout(firstTokenTimer);
    if (thinkingTimer !== null) clearTimeout(thinkingTimer);
    totalTimer = firstTokenTimer = thinkingTimer = null;
    input.abortSignal?.removeEventListener("abort", forwardAbort);
    controller.signal.removeEventListener("abort", cleanup);
  };

  const abortWith = (message: string) => {
    if (!controller.signal.aborted) {
      controller.abort(new Error(message));
    }
  };

  controller.signal.addEventListener("abort", cleanup, { once: true });
  if (input.abortSignal?.aborted) {
    forwardAbort();
  } else {
    input.abortSignal?.addEventListener("abort", forwardAbort, { once: true });
    totalTimer = setTimeout(() => {
      abortWith(`LLM total timeout after ${input.totalTimeoutMs}ms`);
    }, input.totalTimeoutMs);
    firstTokenTimer = setTimeout(() => {
      if (firstTokenPending) {
        abortWith(`LLM first token timeout after ${input.firstTokenTimeoutMs}ms`);
      }
    }, input.firstTokenTimeoutMs);
  }

  return {
    controller,
    markFirstResponseReceived() {
      if (disposed || !firstTokenPending) {
        return;
      }
      firstTokenPending = false;
      if (firstTokenTimer !== null) clearTimeout(firstTokenTimer);
      firstTokenTimer = null;
    },
    markReasoningStarted() {
      if (disposed || textReceived || thinkingTimer !== null || input.thinkingTimeoutMs == null || input.thinkingTimeoutMs <= 0) {
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
    cleanup
  };
}

export function rethrowProviderAbortReason(signal: AbortSignal, error: unknown): never {
  if (signal.aborted && signal.reason instanceof Error) {
    throw signal.reason;
  }
  throw error instanceof Error ? error : new Error(String(error));
}
