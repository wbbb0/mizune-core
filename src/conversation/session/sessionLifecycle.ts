import type { SessionState } from "./sessionTypes.ts";

// Manages generation/response lifecycle transitions for a session state.
export function beginGenerationState(session: SessionState) {
  const messages = session.pendingMessages;
  const pendingReplyGateWaitPasses = session.pendingReplyGateWaitPasses;
  session.pendingMessages = [];
  session.pendingReplyGateWaitPasses = 0;
  session.isGenerating = true;
  session.isResponding = true;
  session.responseEpoch += 1;
  const abortController = new AbortController();
  const responseAbortController = new AbortController();
  session.generationAbortController = abortController;
  session.responseAbortController = responseAbortController;
  return {
    session,
    messages,
    pendingReplyGateWaitPasses,
    abortController,
    responseAbortController,
    responseEpoch: session.responseEpoch
  };
}

// Starts a synthetic generation cycle without consuming pending inbound messages.
export function beginSyntheticGenerationState(session: SessionState) {
  session.isGenerating = true;
  session.isResponding = true;
  session.responseEpoch += 1;
  const abortController = new AbortController();
  const responseAbortController = new AbortController();
  session.generationAbortController = abortController;
  session.responseAbortController = responseAbortController;
  return { session, abortController, responseAbortController, responseEpoch: session.responseEpoch };
}

// Marks generation as finished when the active abort controller still matches.
export function finishGenerationState(session: SessionState, abortController: AbortController): boolean {
  if (session.generationAbortController !== abortController) {
    return false;
  }
  session.isGenerating = false;
  session.generationAbortController = null;
  return true;
}

// Cancels the active generation request for the session.
export function cancelGenerationState(session: SessionState): boolean {
  if (!session.isGenerating || session.generationAbortController == null) {
    return false;
  }

  session.generationAbortController.abort();
  session.isGenerating = false;
  session.generationAbortController = null;
  return true;
}

// Interrupts both generation and outbound response state in one step.
export function interruptResponseState(session: SessionState): { cancelledGeneration: boolean; cancelledOutbound: boolean } {
  const cancelledGeneration = cancelGenerationState(session);
  let cancelledOutbound = false;
  if (session.responseAbortController != null && !session.responseAbortController.signal.aborted) {
    session.responseAbortController.abort();
    cancelledOutbound = true;
  }
  session.isResponding = false;
  return { cancelledGeneration, cancelledOutbound };
}

// Completes the response phase when the epoch still matches.
export function completeResponseState(session: SessionState, expectedResponseEpoch: number): boolean {
  if (session.responseEpoch !== expectedResponseEpoch) {
    return false;
  }
  session.isResponding = false;
  session.responseAbortController = null;
  session.interruptibleGroupTriggerUserId = null;
  return true;
}