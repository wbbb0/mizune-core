import type { InternalSessionTriggerExecution } from "#conversation/session/sessionTypes.ts";
import type {
  MinecraftActorOwnerNotification,
  MinecraftActorOwnerNotificationSink
} from "./actorResourceManager.ts";

interface InternalTriggerDispatcher {
  dispatchInternalTrigger(
    sessionId: string,
    triggerFactory: (target: {
      type: "private" | "group";
      userId: string;
      groupId?: string;
      senderName: string;
    }) => InternalSessionTriggerExecution
  ): Promise<void>;
}

export function createMinecraftActorOwnerNotificationSink(
  dispatcher: InternalTriggerDispatcher,
  now: () => number = Date.now
): MinecraftActorOwnerNotificationSink {
  return {
    async notify(notification): Promise<void> {
      await dispatcher.dispatchInternalTrigger(notification.ownerSessionId, target => ({
        kind: "minecraft_actor_attention",
        targetType: target.type,
        ...(target.type === "private"
          ? { targetUserId: target.userId }
          : (target.groupId ? { targetGroupId: target.groupId } : {})),
        targetSenderName: target.senderName,
        jobName: buildJobName(notification),
        instruction: buildInstruction(notification),
        enqueuedAt: now(),
        resourceId: notification.resourceId,
        actorId: notification.actorId,
        attentionType: notification.type,
        summary: notification.summary,
        details: notification.details === undefined ? null : JSON.stringify(notification.details)
      }));
    }
  };
}

function buildJobName(notification: MinecraftActorOwnerNotification): string {
  return notification.type === "decision_failed"
    ? `Minecraft Actor 决策失败 (${notification.actorId})`
    : `Minecraft Actor 请求关注 (${notification.actorId})`;
}

function buildInstruction(notification: MinecraftActorOwnerNotification): string {
  if (notification.type === "decision_failed") {
    return "Minecraft Actor 的后台决策失败了。请向所属会话简短说明；如果需要用户干预，明确给出可执行的下一步。";
  }
  return "Minecraft Actor 在游戏中遇到需要会话关注的事件。根据摘要判断是否应通知用户或询问决定；没有必要时可以保持简短。";
}
