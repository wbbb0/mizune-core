import type { SessionState } from "./sessionTypes.ts";
import { isSessionGenerating, isSessionResponding } from "./sessionQueries.ts";
import { beginActiveTranscriptGroup, clearActiveTranscriptGroup } from "./transcriptMetadata.ts";

// Manages generation/response lifecycle transitions for a session state.
export function beginGenerationState(session: SessionState) {
  const messages = session.pendingMessages;
  const pendingReplyGateWaitPasses = session.pendingReplyGateWaitPasses;
  session.pendingMessages = [];
  session.pendingReplyGateWaitPasses = 0;
  session.currentReplyTarget = resolveReplyTarget(messages);
  beginActiveTranscriptGroup(session);
  session.phase = { kind: "turn_planner_evaluating" };
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
  session.currentReplyTarget = null;
  beginActiveTranscriptGroup(session);
  session.phase = { kind: "requesting_llm" };
  session.responseEpoch += 1;
  const abortController = new AbortController();
  const responseAbortController = new AbortController();
  session.generationAbortController = abortController;
  session.responseAbortController = responseAbortController;
  return { session, abortController, responseAbortController, responseEpoch: session.responseEpoch };
}

function resolveReplyTarget(messages: SessionState["pendingMessages"]): SessionState["currentReplyTarget"] {
  const first = messages[0];
  if (!first) {
    return null;
  }
  return {
    chatType: first.chatType,
    userId: first.userId,
    senderName: first.senderName,
    ...(first.groupId ? { groupId: first.groupId } : {}),
    firstMessageAt: first.receivedAt
  };
}

// Marks generation as finished when the active abort controller still matches.
export function finishGenerationState(session: SessionState, abortController: AbortController): boolean {
  if (session.generationAbortController !== abortController) {
    return false;
  }
  session.phase = { kind: "delivering" };
  session.generationAbortController = null;
  return true;
}

// Cancels the active generation request for the session.
export function cancelGenerationState(session: SessionState): boolean {
  if (!isSessionGenerating(session) || session.generationAbortController == null) {
    return false;
  }

  session.generationAbortController.abort();
  session.phase = { kind: "delivering" };
  session.generationAbortController = null;
  return true;
}

// Interrupts both generation and outbound response state in one step.
export function interruptResponseState(session: SessionState): { cancelledGeneration: boolean; cancelledOutbound: boolean } {
  session.mutationEpoch += 1;
  const cancelledGeneration = cancelGenerationState(session);
  let cancelledOutbound = false;
  if (session.responseAbortController != null && !session.responseAbortController.signal.aborted) {
    session.responseAbortController.abort();
    cancelledOutbound = true;
  }
  session.phase = { kind: "idle" };
  clearActiveTranscriptGroup(session);
  session.currentReplyTarget = null;
  return { cancelledGeneration, cancelledOutbound };
}

// Completes the response phase when the epoch still matches.
export function completeResponseState(session: SessionState, expectedResponseEpoch: number): boolean {
  if (session.responseEpoch !== expectedResponseEpoch) {
    return false;
  }
  session.phase = { kind: "idle" };
  session.responseAbortController = null;
  session.currentReplyTarget = null;
  clearActiveTranscriptGroup(session);
  return true;
}
