import { normalizeOneBotMessageId } from "#services/onebot/messageId.ts";
import type { SessionPersistence } from "#conversation/session/sessionPersistence.ts";
import type {
  SessionOutboundHistoryAccess,
  SessionPersistenceAccess
} from "#conversation/session/sessionCapabilities.ts";
import type { OneBotClient } from "#services/onebot/onebotClient.ts";
import type { Logger } from "pino";
import type { SetupStateStore } from "#identity/setupStateStore.ts";
import type { UserIdentityStore } from "#identity/userIdentityStore.ts";
import type { UserStore } from "#identity/userStore.ts";
import type { InternalTranscriptItem } from "#conversation/session/sessionTypes.ts";

export interface AppSetupSupportDeps {
  logger: Logger;
  oneBotClient: OneBotClient;
  sessionManager: SessionPersistenceAccess & SessionOutboundHistoryAccess;
  sessionPersistence: SessionPersistence;
  setupStore: SetupStateStore;
  userIdentityStore: UserIdentityStore;
  userStore: UserStore;
}

// Creates setup-time helpers for owner binding, setup prompts, and session persistence.
export function createAppSetupSupport(deps: AppSetupSupportDeps) {
  const {
    logger,
    oneBotClient,
    sessionManager,
    sessionPersistence,
    setupStore,
    userIdentityStore,
    userStore
  } = deps;

  // Collapse synchronous mutations into one snapshot. Persistence still serializes
  // writes per session; no timer delays or cross-session ordering are introduced.
  const pendingPersistence = new Map<string, string>();
  const persistSession = (sessionId: string, reason: string) => {
    const alreadyPending = pendingPersistence.has(sessionId);
    pendingPersistence.set(sessionId, reason);
    if (alreadyPending) return;
    queueMicrotask(() => {
      const latestReason = pendingPersistence.get(sessionId);
      pendingPersistence.delete(sessionId);
      try {
        void sessionPersistence.save(sessionManager.getPersistedSession(sessionId)).then(() => {
          logger.debug({ sessionId, reason: latestReason }, "session_persisted");
        }).catch((error: unknown) => {
          logger.error({ error, sessionId, reason: latestReason }, "session_persist_failed");
        });
      } catch (error) {
        logger.error({ error, sessionId, reason: latestReason }, "session_persist_failed");
      }
    });
  };

  // Sends text immediately and optionally mirrors it into session history.
  const sendImmediateText = async (params: {
    sessionId: string;
    userId: string;
    externalUserId?: string;
    groupId?: string;
    text: string;
    recordInHistory?: boolean;
    transcriptItem?: InternalTranscriptItem;
    recordForRetract?: boolean;
    autoRetractAfterMs?: number;
  }) => {
    const payload = await oneBotClient.sendText({
      text: params.text,
      ...(params.groupId
        ? { groupId: params.groupId }
        : { userId: params.externalUserId ?? params.userId })
    });
    const messageId = normalizeOneBotMessageId(payload.data?.message_id);
    if ((params.recordForRetract ?? true) && messageId != null) {
      sessionManager.recordSentMessage(params.sessionId, {
        messageId,
        text: params.text,
        sentAt: Date.now()
      });
    }
    if (params.recordInHistory ?? true) {
      sessionManager.appendAssistantHistory(params.sessionId, {
        chatType: params.groupId ? "group" : "private",
        userId: params.userId,
        senderName: params.userId,
        text: params.text,
        ...(messageId != null ? {
          deliveryRef: {
            platform: "onebot" as const,
            messageId
          }
        } : {})
      }, Date.now());
      logger.info(
        {
          sessionId: params.sessionId,
          role: "assistant",
          contentLength: params.text.length,
          contentPreview: params.text.slice(0, 120)
        },
        "history_assistant_appended"
      );
      persistSession(params.sessionId, "command_response_sent");
    } else if (params.transcriptItem) {
      sessionManager.appendInternalTranscript(params.sessionId, params.transcriptItem);
      persistSession(params.sessionId, "non_llm_visible_response_recorded");
    }

    if (messageId != null && typeof params.autoRetractAfterMs === "number" && params.autoRetractAfterMs > 0) {
      const timer = setTimeout(() => {
        void oneBotClient.deleteMessage(messageId).catch((error: unknown) => {
          logger.warn(
            {
              error,
              sessionId: params.sessionId,
              messageId
            },
            "auto_retract_failed"
          );
        });
      }, params.autoRetractAfterMs);
      timer.unref?.();
    }
  };

  // 初始化以显式确认状态为准；字段留空仍然可以完成配置。
  const buildSetupInstructionText = async (): Promise<string> => {
    if ((await setupStore.get()).state === "ready") {
      return "基础人格已确认，可以开始对话。需要修改时，请在私聊中使用 .config persona，修改后用 .confirm 保存。";
    }
    return [
      "当前实例需要先确认基础人格 persona。请在私聊中开始配置，我们会逐项推荐名称、性格等信息。",
      "你可以描述希望的设定，也可以接受推荐或明确留空；完成这一阶段后发送 .confirm 保存，.cancel 放弃草稿。",
      "RP 模式还会继续配置社交设定；沉浸模式还需确认具身设定和本会话的动态状态。"
    ].join("\n");
  };

  // Notifies the owner when setup is still blocked on persona information.
  const notifyOwnerSetupIfNeeded = async (options?: { force?: boolean; ownerExternalId?: string }): Promise<void> => {
    const currentState = await setupStore.get();
    const ownerExternalId = options?.ownerExternalId
      ?? (await userIdentityStore.findIdentityByInternalUserId("owner"))?.externalId;
    if (!ownerExternalId || currentState.state !== "needs_persona") {
      return;
    }
    if (!options?.force && currentState.ownerPromptSentAt != null) {
      return;
    }
    await oneBotClient.sendText({
      userId: ownerExternalId,
      text: await buildSetupInstructionText()
    });
    await setupStore.markOwnerPromptSent();
  };

  // Assigns the owner and advances setup state after a valid private command.
  const assignOwner = async (params: {
    channelId: string;
    requesterUserId: string;
    targetUserId: string;
    chatType: "private" | "group";
  }): Promise<string> => {
    if (params.chatType !== "private") {
      return "`.own` 只能在 OneBot 私聊里使用。";
    }
    const currentState = await setupStore.get();
    if (currentState.state === "ready") {
      return "当前实例已完成 OneBot 初始化，`.own` 不再可用。";
    }
    const currentOwnerIdentity = await userIdentityStore.findIdentityByInternalUserId("owner");
    if (currentOwnerIdentity) {
      return `当前实例已绑定管理者：${currentOwnerIdentity.externalId}。请由该管理者继续完成设定。`;
    }
    const targetUserId = params.targetUserId.trim();
    if (!targetUserId) {
      return "请提供有效的用户 ID，或直接使用 `.own` 绑定自己。";
    }
    const friends = await oneBotClient.getFriendList();
    const matchedFriend = friends.find((friend) => String(friend.user_id) === targetUserId);
    if (!matchedFriend) {
      return "只能把已经在 OneBot 中与 bot 建立好友关系的用户 ID 设为管理者。";
    }

    await userStore.ensureInternalUser("owner");
    await userIdentityStore.bindOwnerIdentity({
      channelId: params.channelId,
      externalId: targetUserId
    });
    const setupState = await setupStore.advanceAfterOwnerBound();

    if (targetUserId !== params.requesterUserId) {
      await oneBotClient.sendText({
        userId: targetUserId,
        text: await buildSetupInstructionText()
      });
      await setupStore.markOwnerPromptSent();
      return `已将 ${targetUserId} 设为管理者，并通知对方${setupState.state === "ready" ? "可以开始对话" : "继续确认角色设定"}。`;
    }

    await notifyOwnerSetupIfNeeded({ force: true, ownerExternalId: targetUserId });
    return setupState.state === "ready" ? "已将你设为管理者。基础人格已确认，可以开始对话。" : "已将你设为管理者。接下来请配置并确认基础人格，允许留空。";
  };

  return {
    persistSession,
    sendImmediateText,
    buildSetupInstructionText,
    notifyOwnerSetupIfNeeded,
    assignOwner
  };
}
