import type { InternalSessionTriggerExecution } from "#conversation/session/sessionManager.ts";
import { createInternalTriggerDispatcher } from "./internalTriggerDispatcher.ts";
import type { ScheduledTaskDispatcherDeps } from "./scheduledTaskDispatcherDeps.ts";

export function createScheduledTaskDispatcher(
  deps: ScheduledTaskDispatcherDeps,
  handlers: {
    runInternalTriggerSession: (sessionId: string, trigger: InternalSessionTriggerExecution) => Promise<void>;
  }
) {
  const dispatcher = createInternalTriggerDispatcher(deps, handlers);

  return {
    async dispatchScheduledPrompt(input: {
      sessionId: string;
      jobName: string;
      instruction: string;
    }): Promise<void> {
      await dispatcher.dispatchTrigger({
        sessionId: input.sessionId,
        queueLogEvent: "scheduled_job_queued",
        createTrigger: (target): InternalSessionTriggerExecution => target.type === "group"
          ? {
              kind: "scheduled_instruction",
              targetType: "group",
              ...(target.groupId ? { targetGroupId: target.groupId } : {}),
              targetSenderName: target.senderName,
              jobName: input.jobName,
              instruction: input.instruction,
              enqueuedAt: Date.now()
            }
          : {
              kind: "scheduled_instruction",
              targetType: "private",
              targetUserId: target.userId,
              targetSenderName: target.senderName,
              jobName: input.jobName,
              instruction: input.instruction,
              enqueuedAt: Date.now()
            }
      });
    },
    async dispatchInternalTrigger(
      sessionId: string,
      triggerFactory: (target: {
        type: "private" | "group";
        userId: string;
        groupId?: string;
        senderName: string;
      }) => InternalSessionTriggerExecution
    ): Promise<void> {
      await dispatcher.dispatchTrigger({
        sessionId,
        queueLogEvent: "internal_trigger_queued",
        createTrigger: triggerFactory
      });
    }
  };
}
