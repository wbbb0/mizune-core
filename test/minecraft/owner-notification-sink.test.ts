import assert from "node:assert/strict";
import test from "node:test";
import type { InternalSessionTriggerExecution } from "../../src/conversation/session/sessionTypes.ts";
import { createMinecraftActorOwnerNotificationSink } from "../../src/services/minecraft/ownerNotificationSink.ts";

test("Minecraft owner notification becomes an inline internal session trigger", async () => {
  const dispatched: Array<{ sessionId: string; trigger: InternalSessionTriggerExecution }> = [];
  const sink = createMinecraftActorOwnerNotificationSink({
    async dispatchInternalTrigger(sessionId, factory) {
      dispatched.push({
        sessionId,
        trigger: factory({
          type: "private",
          userId: "owner",
          senderName: "主人"
        })
      });
    }
  }, () => 123);

  await sink.notify({
    ownerSessionId: "onebot:private:owner",
    resourceId: "res_minecraft_1",
    actorId: "actor-1",
    type: "game_attention",
    summary: "找不到游戏内的 Alice",
    details: { lastSeenSecondsAgo: 30 }
  });

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]?.sessionId, "onebot:private:owner");
  assert.deepEqual(dispatched[0]?.trigger, {
    kind: "minecraft_actor_attention",
    targetType: "private",
    targetUserId: "owner",
    targetSenderName: "主人",
    jobName: "Minecraft Actor 请求关注 (actor-1)",
    instruction: "Minecraft Actor 在游戏中遇到需要会话关注的事件。根据摘要判断是否应通知用户或询问决定；没有必要时可以保持简短。",
    enqueuedAt: 123,
    resourceId: "res_minecraft_1",
    actorId: "actor-1",
    attentionType: "game_attention",
    summary: "找不到游戏内的 Alice",
    details: "{\"lastSeenSecondsAgo\":30}"
  });
});
