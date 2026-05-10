import type { InternalSessionTriggerExecution } from "#conversation/session/sessionTypes.ts";
import { createInternalTriggerEvent } from "#conversation/session/internalTranscriptEvents.ts";
import { parseChatSessionIdentity } from "#conversation/session/sessionIdentity.ts";
import { resolveStoredUserForSessionPrivateTarget } from "#identity/userIdentityResolution.ts";
import type { ScheduledTaskDispatcherDeps } from "./scheduledTaskDispatcherDeps.ts";

// Owns queue-or-run behavior for synthetic session triggers while depending on
// only the trigger-related session surface.
//
// Background-event triggers (terminal, download, comfy) are routed to the
// inline queue so the next LLM request within the active tool-call loop can
// consume them. Scheduled instructions stay on the classic path of queuing
// until the current response winds down and then opening a fresh session.
export function createInternalTriggerDispatcher(
  deps: ScheduledTaskDispatcherDeps,
  handlers: {
    runInternalTriggerSession: (sessionId: string, trigger: InternalSessionTriggerExecution) => Promise<void>;
    wakeInlineBatch: (sessionId: string) => void;
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

    // Scheduled instructions are stand-alone topics. Queue them behind the
    // active response and open a fresh session once the current turn winds down.
    if (trigger.kind === "scheduled_instruction") {
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
      return;
    }

    // Background-event triggers go inline. They are enqueued and either
    // picked up by the next LLM request in the tool-call loop or, when the
    // session is idle, consumed immediately via a batch session.
    const queueSize = sessionManager.enqueueInlineTrigger(session.id, trigger);
    logger.info(
      {
        sessionId: session.id,
        triggerKind: trigger.kind,
        queueSize
      },
      "inline_trigger_queued"
    );
    sessionManager.appendInternalTranscript(session.id, createInternalTriggerEvent({
      trigger,
      stage: "queued_inline"
    }));
    persistSession(session.id, "inline_trigger_queued");

    if (!sessionManager.hasActiveResponse(session.id) && session.pendingMessages.length === 0 && !sessionManager.hasPendingInternalTriggers(session.id)) {
      handlers.wakeInlineBatch(session.id);
    }
  };

  return {
    dispatchTrigger
  };
}
