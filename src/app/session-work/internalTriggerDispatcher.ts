import type { InternalSessionTriggerExecution } from "#conversation/session/sessionManager.ts";
import { createInternalTriggerEvent } from "#conversation/session/internalTranscriptEvents.ts";
import type { ScheduledTaskDispatcherDeps } from "./scheduledTaskDispatcherDeps.ts";

function parseSessionId(sessionId: string): { type: "private" | "group"; userId: string; groupId?: string } | null {
  if (sessionId.startsWith("private:")) {
    return {
      type: "private",
      userId: sessionId.slice("private:".length)
    };
  }

  if (sessionId.startsWith("group:")) {
    const groupId = sessionId.slice("group:".length);
    return {
      type: "group",
      userId: groupId,
      groupId
    };
  }

  return null;
}

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
    const target = parseSessionId(input.sessionId);
    if (!target) {
      throw new Error(`Unsupported sessionId: ${input.sessionId}`);
    }

    const senderName = target.type === "group"
      ? `群 ${target.groupId ?? target.userId}`
      : ((await userStore.getByUserId(target.userId))?.preferredAddress ?? target.userId);

    const session = sessionManager.ensureSession({
      id: input.sessionId,
      type: target.type
    });
    const trigger = input.createTrigger({
      type: target.type,
      userId: target.userId,
      ...(target.groupId ? { groupId: target.groupId } : {}),
      senderName
    });
    sessionManager.appendInternalTranscript(session.id, createInternalTriggerEvent({
      trigger,
      stage: "received"
    }));
    persistSession(session.id, "internal_trigger_received");

    if (sessionManager.hasActiveResponse(session.id) || session.pendingMessages.length > 0 || session.pendingInternalTriggers.length > 0) {
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
