import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { SessionAppRuntimeAccess } from "#conversation/session/sessionCapabilities.ts";
import type { SessionState } from "#conversation/session/sessionTypes.ts";
import { parseChatSessionIdentity } from "#conversation/session/sessionIdentity.ts";
import { createMessageProcessingContext } from "#app/messaging/messageContextBuilder.ts";
import type { MessageHandlerServices } from "#app/messaging/messageHandlerTypes.ts";
import { normalizeOneBotMessageId } from "#services/onebot/messageId.ts";
import { parseIncomingMessage } from "#services/onebot/messageParsing.ts";
import {
  createIncomingHistoryMessage,
  resolveOneBotEventSourceRef,
} from "#app/messaging/incomingHistory.ts";
import type {
  OneBotHistoryMessage,
  OneBotMessageEvent,
  OneBotSender
} from "#services/onebot/types.ts";
import type { OneBotClient } from "#services/onebot/onebotClient.ts";

interface OneBotHistoryBackfillDeps {
  config: AppConfig;
  logger: Logger;
  importBeforeMs: number;
  oneBotClient: Pick<OneBotClient, "getLoginInfo" | "getPrivateMessageHistory" | "getGroupMessageHistory">;
  sessionManager: SessionAppRuntimeAccess;
  audioStore: MessageHandlerServices["audioStore"];
  chatFileStore: MessageHandlerServices["chatFileStore"];
  userIdentityStore: MessageHandlerServices["userIdentityStore"];
  userStore: MessageHandlerServices["userStore"];
  setupStore: MessageHandlerServices["setupStore"];
  persistSession: (sessionId: string, reason: string) => void;
}

interface BackfillStats {
  scannedSessions: number;
  fetchedMessages: number;
  appendedMessages: number;
  skippedMessages: number;
  failedSessions: number;
}

export async function backfillOneBotSessionHistory(deps: OneBotHistoryBackfillDeps): Promise<BackfillStats> {
  const stats: BackfillStats = {
    scannedSessions: 0,
    fetchedMessages: 0,
    appendedMessages: 0,
    skippedMessages: 0,
    failedSessions: 0
  };
  const backfillConfig = deps.config.onebot.historyBackfill;
  if (!deps.config.onebot.enabled || !backfillConfig.enabled) {
    return stats;
  }
  if (deps.config.onebot.provider !== "napcat") {
    deps.logger.warn(
      { provider: deps.config.onebot.provider },
      "onebot_history_backfill_skipped_unsupported_provider"
    );
    return stats;
  }

  let loginInfo: Awaited<ReturnType<OneBotHistoryBackfillDeps["oneBotClient"]["getLoginInfo"]>>;
  try {
    loginInfo = await deps.oneBotClient.getLoginInfo();
  } catch (error: unknown) {
    deps.logger.warn({ error }, "onebot_history_backfill_login_info_failed");
    return stats;
  }
  const selfId = loginInfo.user_id;
  let remainingTotal = backfillConfig.maxTotalMessages;
  for (const session of deps.sessionManager.listSessions()) {
    if (remainingTotal <= 0) {
      break;
    }
    const target = resolveBackfillTarget(deps.config, session);
    if (target == null) {
      continue;
    }
    stats.scannedSessions += 1;
    try {
      const count = Math.min(backfillConfig.maxMessagesPerSession, remainingTotal);
      const fetchedMessages = target.kind === "private"
        ? await deps.oneBotClient.getPrivateMessageHistory({ userId: target.userId, count })
        : await deps.oneBotClient.getGroupMessageHistory({ groupId: target.groupId, count });
      const messages = fetchedMessages.slice(0, count);
      stats.fetchedMessages += messages.length;
      const appended = await appendSessionBackfillMessages(deps, {
        sessionId: session.id,
        importBeforeMs: deps.importBeforeMs,
        selfId,
        messages,
        fallbackMessageType: target.kind === "private" ? "private" : "group"
      });
      stats.appendedMessages += appended;
      stats.skippedMessages += messages.length - appended;
      remainingTotal -= messages.length;
      if (appended > 0) {
        deps.persistSession(session.id, "onebot_history_backfilled");
      }
      if (backfillConfig.requestDelayMs > 0) {
        await delay(backfillConfig.requestDelayMs);
      }
    } catch (error: unknown) {
      stats.failedSessions += 1;
      deps.logger.warn({ error, sessionId: session.id }, "onebot_history_backfill_session_failed");
    }
  }

  deps.logger.info(stats, "onebot_history_backfill_completed");
  return stats;
}

function resolveBackfillTarget(
  config: AppConfig,
  session: SessionState
): { kind: "private"; userId: string } | { kind: "group"; groupId: string } | null {
  if (session.source !== "onebot") {
    return null;
  }
  const identity = parseChatSessionIdentity(session.id);
  if (identity == null || identity.channelId !== config.configRuntime.instanceName) {
    return null;
  }
  return identity.kind === "private"
    ? { kind: "private", userId: identity.userId }
    : { kind: "group", groupId: identity.groupId };
}

async function appendSessionBackfillMessages(
  deps: OneBotHistoryBackfillDeps,
  input: {
    sessionId: string;
    importBeforeMs: number;
    selfId: number;
    messages: OneBotHistoryMessage[];
    fallbackMessageType: "private" | "group";
  }
): Promise<number> {
  const sortedMessages = [...input.messages].sort(compareHistoryMessages);
  let appended = 0;
  const importBeforeTimeSec = Math.floor(input.importBeforeMs / 1000);
  for (const message of sortedMessages) {
    const messageId = normalizeOneBotMessageId(message.message_id);
    if (messageId == null || message.user_id == null || message.user_id === input.selfId) {
      continue;
    }
    const timestampMs = resolveHistoryMessageTimestampMs(message, importBeforeTimeSec);
    if (timestampMs == null) {
      continue;
    }

    const event = createBackfillEvent(message, {
      selfId: input.selfId,
      fallbackMessageType: input.fallbackMessageType
    });
    const sourceRef = resolveOneBotEventSourceRef(event);
    if (!deps.sessionManager.canInsertUserHistoryByTimestamp(input.sessionId, {
      ...(sourceRef ? { sourceRef } : {}),
      timestampMs
    })) {
      continue;
    }
    const parsed = parseIncomingMessage(event, {
      channelId: deps.config.configRuntime.instanceName
    });
    if (parsed == null) {
      continue;
    }
    const context = await createMessageProcessingContext(
      {
        audioStore: deps.audioStore,
        chatFileStore: deps.chatFileStore,
        sessionManager: deps.sessionManager,
        userStore: deps.userStore,
        setupStore: deps.setupStore,
        userIdentityStore: deps.userIdentityStore
      },
      parsed,
      {
        targetSessionId: input.sessionId,
        delivery: "onebot"
      }
    );
    if (deps.sessionManager.insertUserHistoryByTimestamp(
      context.session.id,
      createIncomingHistoryMessage(context, sourceRef),
      timestampMs
    )) {
      appended += 1;
    }
  }
  return appended;
}

function createBackfillEvent(
  message: OneBotHistoryMessage,
  input: {
    selfId: number;
    fallbackMessageType: "private" | "group";
  }
): OneBotMessageEvent {
  const messageType = message.message_type === "private" || message.message_type === "group"
    ? message.message_type
    : input.fallbackMessageType;
  const userId = message.user_id ?? 0;
  const sender = normalizeSender(message.sender, userId);
  const messageId = normalizeOneBotMessageId(message.message_id) ?? 0;
  return {
    post_type: "message",
    message_type: messageType,
    sub_type: message.sub_type ?? "normal",
    message_id: messageId,
    user_id: userId,
    ...(messageType === "group" && message.group_id != null ? { group_id: message.group_id } : {}),
    message: message.message,
    raw_message: message.raw_message ?? "",
    sender,
    self_id: input.selfId,
    time: message.time ?? Math.floor(Date.now() / 1000),
    ...(message.font != null ? { font: message.font } : {})
  };
}

function normalizeSender(sender: Record<string, unknown> | undefined, fallbackUserId: number): OneBotSender {
  const source = sender ?? {};
  return {
    user_id: typeof source.user_id === "number" ? source.user_id : fallbackUserId,
    ...(typeof source.nickname === "string" ? { nickname: source.nickname } : {}),
    ...(typeof source.card === "string" ? { card: source.card } : {}),
    ...(typeof source.sex === "string" ? { sex: source.sex } : {}),
    ...(typeof source.age === "number" ? { age: source.age } : {}),
    ...(typeof source.role === "string" ? { role: source.role } : {})
  };
}

function compareHistoryMessages(left: OneBotHistoryMessage, right: OneBotHistoryMessage): number {
  const leftTime = left.time ?? 0;
  const rightTime = right.time ?? 0;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return (normalizeOneBotMessageId(left.message_id) ?? 0) - (normalizeOneBotMessageId(right.message_id) ?? 0);
}

function resolveHistoryMessageTimestampMs(message: OneBotHistoryMessage, importBeforeTimeSec: number): number | null {
  if (typeof message.time !== "number" || !Number.isFinite(message.time)) {
    return null;
  }
  const timeSec = Math.trunc(message.time);
  // OneBot history timestamps are second-granularity; leave the whole startup
  // second to live ingress so new messages cannot be swallowed by backfill.
  if (timeSec >= importBeforeTimeSec) {
    return null;
  }
  return timeSec * 1000;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
