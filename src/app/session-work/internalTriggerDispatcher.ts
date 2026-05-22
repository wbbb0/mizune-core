import type { InternalSessionTriggerExecution } from "#conversation/session/sessionTypes.ts";
import { createInternalTriggerEvent } from "#conversation/session/internalTranscriptEvents.ts";
import { parseSessionIdentity } from "#conversation/session/sessionIdentity.ts";
import { resolveStoredUserForSessionPrivateTarget } from "#identity/userIdentityResolution.ts";
import type { ScheduledTaskDispatcherDeps } from "./scheduledTaskDispatcherDeps.ts";

type InternalTriggerTarget =
  | {
      type: "private";
      userId: string;
      senderName: string;
    }
  | {
      type: "group";
      userId: string;
      groupId: string;
      senderName: string;
    };

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
    targetHint?: {
      userId?: string | null;
      senderName?: string | null;
    };
    createTrigger: (target: InternalTriggerTarget) => InternalSessionTriggerExecution;
    queueLogEvent: string;
  }): Promise<void> => {
    const parsed = parseSessionIdentity(input.sessionId);
    if (parsed.kind !== "private" && parsed.kind !== "group" && parsed.kind !== "web") {
      throw new Error(`Unsupported sessionId: ${input.sessionId}`);
    }

    const session = sessionManager.ensureSession(
      parsed.kind === "web"
        ? {
            id: input.sessionId,
            type: "private",
            source: "web"
          }
        : {
            id: input.sessionId,
            type: parsed.kind
          }
    );
    const target = await resolveInternalTriggerTarget({
      sessionId: input.sessionId,
      parsed,
      session,
      ...(input.targetHint ? { hint: input.targetHint } : {}),
      userIdentityStore: deps.userIdentityStore,
      userStore
    });
    const trigger = input.createTrigger(target);
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

async function resolveInternalTriggerTarget(input: {
  sessionId: string;
  parsed: ReturnType<typeof parseSessionIdentity>;
  session: ReturnType<ScheduledTaskDispatcherDeps["sessionManager"]["ensureSession"]>;
  hint?: {
    userId?: string | null;
    senderName?: string | null;
  };
  userIdentityStore: ScheduledTaskDispatcherDeps["userIdentityStore"];
  userStore: ScheduledTaskDispatcherDeps["userStore"];
}): Promise<InternalTriggerTarget> {
  if (input.parsed.kind === "group") {
    return {
      type: "group",
      userId: input.parsed.groupId,
      groupId: input.parsed.groupId,
      senderName: `群 ${input.parsed.groupId}`
    };
  }

  if (input.parsed.kind === "private") {
    return {
      type: "private",
      userId: input.parsed.userId,
      senderName: (await resolveStoredUserForSessionPrivateTarget({
        sessionId: input.sessionId,
        userIdentityStore: input.userIdentityStore,
        userStore: input.userStore
      }))?.preferredAddress ?? input.parsed.userId
    };
  }

  const participantId = input.hint?.userId
    ?? input.session.participantRef.id
    ?? input.parsed.value;
  const senderName = input.hint?.senderName
    ?? input.session.title
    ?? participantId;
  if (input.session.type === "group") {
    const groupId = input.session.participantRef.id || input.parsed.value;
    return {
      type: "group",
      userId: participantId,
      groupId,
      senderName
    };
  }

  return {
    type: "private",
    userId: participantId,
    senderName
  };
}
