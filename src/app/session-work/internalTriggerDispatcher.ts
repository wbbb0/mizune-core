import type { InternalSessionTriggerExecution } from "#conversation/session/sessionTypes.ts";
import { createInternalTriggerEvent } from "#conversation/session/internalTranscriptEvents.ts";
import { parseChatSessionIdentity } from "#conversation/session/sessionIdentity.ts";
import { resolveStoredUserForSessionPrivateTarget } from "#identity/userIdentityResolution.ts";
import type { ScheduledTaskDispatcherDeps } from "./scheduledTaskDispatcherDeps.ts";

// Owns queue-or-run behavior for synthetic session triggers while depending on
// only the trigger-related session surface.
export function createInternalTriggerDispatcher(
  deps: ScheduledTaskDispatcherDeps,
  handlers: {
    runInternalTriggerSession: (sessionId: string, trigger: InternalSessionTriggerExecution) => Promise<void>;
  }
) {
  const {
    logger,
    sessionManager,
    userStore,
    persistSession
  } = deps;

  const dispatchTrigger = async (input: {
    sessionId: string;
    createTrigger: (target: {
      type: "private" | "group";
      userId: string;
      groupId?: string;
      senderName: string;
    }) => InternalSessionTriggerExecution;
    queueLogEvent: string;
  }): Promise<void> => {
    const target = parseChatSessionIdentity(input.sessionId);
    if (!target) {
      throw new Error(`Unsupported sessionId: ${input.sessionId}`);
    }

    const senderName = target.kind === "group"
      ? `群 ${target.groupId}`
      : ((await resolveStoredUserForSessionPrivateTarget({
          sessionId: input.sessionId,
          userIdentityStore: deps.userIdentityStore,
          userStore
        }))?.preferredAddress ?? target.userId);

    const session = sessionManager.ensureSession({
      id: input.sessionId,
      type: target.kind
    });
    const trigger = input.createTrigger({
      type: target.kind,
      ...(target.kind === "private"
        ? { userId: target.userId }
        : { userId: target.groupId, groupId: target.groupId }),
      senderName
    });
    sessionManager.appendInternalTranscript(session.id, createInternalTriggerEvent({
      trigger,
      stage: "received"
    }));
    persistSession(session.id, "internal_trigger_received");

    if (sessionManager.hasActiveResponse(session.id) || session.pendingMessages.length > 0 || sessionManager.hasPendingInternalTriggers(session.id)) {
      await new Promise<void>((resolve, reject) => {
        const queueSize = sessionManager.enqueueInternalTrigger(session.id, {
          ...trigger,
          resolveCompletion: resolve,
          rejectCompletion: reject
        });
        logger.info(
          {
            sessionId: session.id,
            triggerKind: trigger.kind,
            queueSize
          },
          input.queueLogEvent
        );
        sessionManager.appendInternalTranscript(session.id, createInternalTriggerEvent({
          trigger,
          stage: "queued"
        }));
        persistSession(session.id, "internal_trigger_queued");
      });
      return;
    }

    await handlers.runInternalTriggerSession(session.id, trigger);
  };

  return {
    dispatchTrigger
  };
}
