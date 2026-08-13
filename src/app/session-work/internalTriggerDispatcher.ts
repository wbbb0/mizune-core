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
    abortSignal?: AbortSignal;
  }): Promise<void> => {
    input.abortSignal?.throwIfAborted();
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
    attachRuntimeAbortSignal(trigger, input.abortSignal);
    sessionManager.appendInternalTranscript(session.id, createInternalTriggerEvent({
      trigger,
      stage: "received"
    }));
    persistSession(session.id, "internal_trigger_received");

    // Scheduled instructions and durable Minecraft owner notifications are
    // stand-alone topics. The dispatcher resolves only after their generation
    // finishes, so the producer can keep its durable outbox item unacknowledged
    // across process crashes or generation failures.
    if (trigger.kind === "scheduled_instruction" || trigger.kind === "minecraft_actor_attention") {
      if (
        sessionManager.hasActiveResponse(session.id)
        || session.pendingMessages.length > 0
        || sessionManager.hasQueuedGroupReplyTargets(session.id)
        || sessionManager.hasPendingInternalTriggers(session.id)
      ) {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          let onAbort = (): void => {};
          const finish = (operation: () => void): void => {
            if (settled) return;
            settled = true;
            input.abortSignal?.removeEventListener("abort", onAbort);
            operation();
          };
          const queuedTrigger: InternalSessionTriggerExecution = {
            ...trigger,
            resolveCompletion: () => finish(resolve),
            rejectCompletion: error => finish(() => reject(error))
          };
          attachRuntimeAbortSignal(queuedTrigger, input.abortSignal);
          onAbort = (): void => {
            if (!sessionManager.removeInternalTrigger(session.id, queuedTrigger)) return;
            finish(() => reject(abortSignalError(input.abortSignal!)));
            persistSession(session.id, "internal_trigger_cancelled");
          };
          input.abortSignal?.addEventListener("abort", onAbort, { once: true });
          const queueSize = sessionManager.enqueueInternalTrigger(session.id, queuedTrigger);
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
          if (input.abortSignal?.aborted) onAbort();
        });
        return;
      }
      await handlers.runInternalTriggerSession(session.id, trigger);
      return;
    }

    // Other background-event triggers go inline. They are enqueued and either
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

function attachRuntimeAbortSignal(
  trigger: InternalSessionTriggerExecution,
  signal?: AbortSignal
): void {
  if (!signal || trigger.kind !== "minecraft_actor_attention") return;
  Object.defineProperty(trigger, "abortSignal", {
    configurable: true,
    enumerable: false,
    value: signal
  });
}

function abortSignalError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(String(signal.reason ?? "内部事件已中止"));
  error.name = "AbortError";
  return error;
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
