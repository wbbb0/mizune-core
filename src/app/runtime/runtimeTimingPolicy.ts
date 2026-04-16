export const GENERATION_ABORT_GRACE_MS = 150;

// Give immediate stop/interrupt commands a short chance to abort before generation
// starts expensive provider work. This is still time-based, so keep it centralized.
export async function waitForGenerationAbortGraceWindow(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, GENERATION_ABORT_GRACE_MS);
    timeout.unref?.();

    const onAbort = () => {
      clearTimeout(timeout);
      resolve();
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}
