import type { OneBotClient } from "#services/onebot/onebotClient.ts";
import type { QqOfficialClient } from "#services/qqOfficial/client.ts";
import type { MessageReplyContext } from "#services/messaging/incomingMessage.ts";
import type { DeliveryCoordinator } from "#services/messaging/deliveryCoordinator.ts";
import type { OwnerBootstrapTransport } from "../bootstrap/ownerBootstrap.ts";

export function oneBotOwnerBootstrapTransport(client: OneBotClient): OwnerBootstrapTransport {
  return {
    async validateTarget({ targetUserId }) {
      const friends = await client.getFriendList();
      return friends.some(friend => String(friend.user_id) === targetUserId) ? null : "只能把已经在 OneBot 中与 bot 建立好友关系的用户 ID 设为管理者。";
    },
    async notifyTarget(targetUserId, text) { await client.sendText({ userId: targetUserId, text }); }
  };
}

/** Official identities are proven by the current C2C event, never inferred from QQ numbers or another connection. */
export function officialOwnerBootstrapTransport(input: {
  client: QqOfficialClient | undefined;
  replyContext: MessageReplyContext | undefined;
  messaging: DeliveryCoordinator;
  sessionId: string;
}): OwnerBootstrapTransport {
  return {
    async validateTarget(request) {
      const permit = input.replyContext;
      if (!input.client || !permit || permit.chatType !== "private" || permit.connectionId !== request.channelId
        || permit.targetId !== request.requesterUserId) return "请在当前官方机器人的私聊中发送 `.own` 绑定自己。";
      input.client.permits.assert(permit);
      return request.targetUserId === request.requesterUserId ? null : "官方机器人只能通过当前私聊验证本人身份，请直接发送 `.own` 绑定自己。";
    },
    async notifyTarget(_targetUserId, text) {
      await input.messaging.sendText({ sessionId: input.sessionId, replyContext: input.replyContext }, text);
    }
  };
}
