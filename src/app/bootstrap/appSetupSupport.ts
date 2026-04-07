import { normalizeOneBotMessageId } from "#services/onebot/messageId.ts";
import type { SessionPersistence } from "#conversation/session/sessionPersistence.ts";
import type { OneBotClient } from "#services/onebot/onebotClient.ts";
import type { Logger } from "pino";
import type { PersonaStore } from "#persona/personaStore.ts";
import type { SetupStateStore } from "#identity/setupStateStore.ts";
import type { SessionManager } from "#conversation/session/sessionManager.ts";
import type { UserStore } from "#identity/userStore.ts";
import type { WhitelistStore } from "#identity/whitelistStore.ts";
import type { InternalTranscriptItem } from "#conversation/session/sessionManager.ts";

export interface AppSetupSupportDeps {
  logger: Logger;
  oneBotClient: OneBotClient;
  sessionManager: SessionManager;
  sessionPersistence: SessionPersistence;
  personaStore: PersonaStore;
  setupStore: SetupStateStore;
  whitelistStore: WhitelistStore;
  userStore: UserStore;
}

// Creates setup-time helpers for owner binding, setup prompts, and session persistence.
export function createAppSetupSupport(deps: AppSetupSupportDeps) {
  const {
    logger,
    oneBotClient,
    sessionManager,
    sessionPersistence,
    personaStore,
    setupStore,
    whitelistStore,
    userStore
  } = deps;

  // Persists a session snapshot asynchronously without blocking the hot path.
  const persistSession = (sessionId: string, reason: string) => {
    void sessionPersistence.save(sessionManager.getPersistedSession(sessionId)).then(() => {
      logger.debug({ sessionId, reason }, "session_persisted");
    }).catch((error: unknown) => {
      logger.error({ error, sessionId, reason }, "session_persist_failed");
    });
  };

  // Sends text immediately and optionally mirrors it into session history.
  const sendImmediateText = async (params: {
    sessionId: string;
    userId: string;
    groupId?: string;
    text: string;
    recordInHistory?: boolean;
    transcriptItem?: InternalTranscriptItem;
    recordForRetract?: boolean;
    autoRetractAfterMs?: number;
  }) => {
    const payload = await oneBotClient.sendText({
      text: params.text,
      ...(params.groupId ? { groupId: params.groupId } : { userId: params.userId })
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
        text: params.text
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

  // Builds the current owner-facing setup instruction text from persona gaps.
  const buildSetupInstructionText = async (): Promise<string> => {
    const currentPersona = await personaStore.get();
    const missing = setupStore.describeMissingFields(currentPersona);
    if (missing.length === 0) {
      return "当前实例已进入初始化确认阶段，但没有检测到缺失字段。你可以直接补充或微调角色设定。";
    }
    return [
      "当前实例还在初始化，请先补全角色设定。",
      `仍需填写：${missing.map((item) => item.label).join("、")}`,
      "你可以直接发文本描述，也可以发图片辅助设定。"
    ].join("\n");
  };

  // Notifies the owner when setup is still blocked on persona information.
  const notifyOwnerSetupIfNeeded = async (options?: { force?: boolean; ownerId?: string }): Promise<void> => {
    const currentState = await setupStore.get();
    const ownerId = options?.ownerId ?? whitelistStore.getOwnerId();
    if (!ownerId || currentState.state !== "needs_persona") {
      return;
    }
    if (!options?.force && currentState.ownerPromptSentAt != null) {
      return;
    }
    await oneBotClient.sendText({
      userId: ownerId,
      text: await buildSetupInstructionText()
    });
    await setupStore.markOwnerPromptSent();
  };

  // Assigns the owner and advances setup state after a valid private command.
  const assignOwner = async (params: {
    requesterUserId: string;
    targetUserId: string;
    chatType: "private" | "group";
  }): Promise<string> => {
    if (params.chatType !== "private") {
      return "`.own` 只能在私聊里使用。";
    }
    const currentState = await setupStore.get();
    if (currentState.state === "ready") {
      return "当前实例已完成初始化，`.own` 不再可用。";
    }
    const currentOwnerId = whitelistStore.getOwnerId();
    if (currentOwnerId) {
      return `当前实例已绑定 owner：${currentOwnerId}。请由 owner 继续完成设定。`;
    }
    const targetUserId = params.targetUserId.trim();
    if (!targetUserId) {
      return "请提供有效的用户 ID，或直接使用 `.own` 绑定自己。";
    }
    const friends = await oneBotClient.getFriendList();
    const matchedFriend = friends.find((friend) => String(friend.user_id) === targetUserId);
    if (!matchedFriend) {
      return "只能把已经是 bot 好友的用户 ID 设为 owner。";
    }

    await whitelistStore.assignOwner(targetUserId);
    await userStore.setOwner(targetUserId);
    await setupStore.advanceAfterOwnerBound(await personaStore.get());

    if (targetUserId !== params.requesterUserId) {
      await oneBotClient.sendText({
        userId: targetUserId,
        text: await buildSetupInstructionText()
      });
      await setupStore.markOwnerPromptSent();
      return `已将 ${targetUserId} 设为 owner，并通知对方继续完成角色设定。`;
    }

    await notifyOwnerSetupIfNeeded({ force: true, ownerId: targetUserId });
    return "已将你设为 owner。接下来请继续补全角色设定。";
  };

  return {
    persistSession,
    sendImmediateText,
    buildSetupInstructionText,
    notifyOwnerSetupIfNeeded,
    assignOwner
  };
}
