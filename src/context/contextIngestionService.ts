import { createHash } from "node:crypto";
import type { Logger } from "pino";
import type { ContextStore } from "./contextStore.ts";
import type { ContextRawMessage } from "./contextTypes.ts";

export interface ContextIngestionTurnMessage {
  userId: string;
  senderName: string;
  text: string;
  receivedAt: number;
}

export interface ContextIngestionTurn {
  sessionId: string;
  chatType: "private" | "group";
  targetUserIds: string[];
  userMessages: ContextIngestionTurnMessage[];
  assistantText: string;
  completedAt: number;
}

type ContextIngestionStore = Pick<
  ContextStore,
  "upsertRawMessages" | "upsertConversationEpisode" | "upsertUserSearchChunk"
>;

export class ContextIngestionService {
  constructor(
    private readonly contextStore: ContextIngestionStore,
    private readonly logger: Logger
  ) { }

  ingestTurn(input: ContextIngestionTurn): {
    rawMessageCount: number;
    episodeCount: number;
    chunkCount: number;
  } {
    const targetUserIds = uniqueNonEmpty(input.targetUserIds);
    const userMessages = input.userMessages.filter((message) => message.text.trim().length > 0);
    if (targetUserIds.length === 0 || (userMessages.length === 0 && !input.assistantText.trim())) {
      return { rawMessageCount: 0, episodeCount: 0, chunkCount: 0 };
    }

    const rawMessages = buildRawMessages(input, userMessages);
    this.contextStore.upsertRawMessages(rawMessages);

    let episodeCount = 0;
    let chunkCount = 0;
    for (const userId of targetUserIds) {
      const targetMessages = userMessages.filter((message) => message.userId === userId);
      if (targetMessages.length === 0) {
        continue;
      }
      const episodeId = buildStableId("ctx_episode", [
        input.sessionId,
        userId,
        String(input.completedAt),
        ...userMessages.map((message) => `${message.userId}:${message.receivedAt}:${message.text}`),
        input.assistantText
      ]);
      const episodeText = renderEpisodeText({
        userMessages,
        assistantText: input.assistantText
      });
      this.contextStore.upsertConversationEpisode({
        itemId: episodeId,
        userId,
        sessionId: input.sessionId,
        title: "对话回合",
        text: episodeText,
        source: "auto_ingest",
        createdAt: input.completedAt,
        updatedAt: input.completedAt
      });
      episodeCount += 1;

      const chunkText = renderRecallChunkText({
        userMessages: targetMessages,
        assistantText: input.assistantText
      });
      if (chunkText) {
        this.contextStore.upsertUserSearchChunk({
          itemId: buildStableId("ctx_chunk", [episodeId, userId]),
          userId,
          sessionId: input.sessionId,
          title: "近期对话片段",
          text: chunkText,
          source: "auto_ingest",
          createdAt: input.completedAt,
          updatedAt: input.completedAt
        });
        chunkCount += 1;
      }
    }

    this.logger.debug({
      sessionId: input.sessionId,
      targetUserIds,
      rawMessageCount: rawMessages.length,
      episodeCount,
      chunkCount
    }, "context_turn_ingested");

    return {
      rawMessageCount: rawMessages.length,
      episodeCount,
      chunkCount
    };
  }
}

function buildRawMessages(
  input: ContextIngestionTurn,
  userMessages: ContextIngestionTurnMessage[]
): ContextRawMessage[] {
  const rawMessages: ContextRawMessage[] = userMessages.map((message, index) => ({
    messageId: buildStableId("ctx_raw_user", [
      input.sessionId,
      message.userId,
      String(message.receivedAt),
      String(index),
      message.text
    ]),
    userId: message.userId,
    sessionId: input.sessionId,
    chatType: input.chatType,
    role: "user" as const,
    speakerId: message.userId,
    timestampMs: message.receivedAt,
    text: message.text,
    sensitivity: "normal" as const,
    ingestedAt: input.completedAt
  }));
  const assistantText = input.assistantText.trim();
  if (assistantText) {
    rawMessages.push({
      messageId: buildStableId("ctx_raw_assistant", [
        input.sessionId,
        "assistant",
        String(input.completedAt),
        assistantText
      ]),
      userId: "assistant",
      sessionId: input.sessionId,
      chatType: input.chatType,
      role: "assistant",
      speakerId: "assistant",
      timestampMs: input.completedAt,
      text: assistantText,
      sensitivity: "normal",
      ingestedAt: input.completedAt
    });
  }
  return rawMessages;
}

function renderEpisodeText(input: {
  userMessages: ContextIngestionTurnMessage[];
  assistantText: string;
}): string {
  return [
    ...input.userMessages.map((message) => `${message.senderName}(${message.userId})：${message.text.trim()}`),
    input.assistantText.trim() ? `助手：${input.assistantText.trim()}` : null
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function renderRecallChunkText(input: {
  userMessages: ContextIngestionTurnMessage[];
  assistantText: string;
}): string {
  return [
    ...input.userMessages.map((message) => `${message.senderName}：${message.text.trim()}`),
    input.assistantText.trim() ? `助手：${input.assistantText.trim()}` : null
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function uniqueNonEmpty(values: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function buildStableId(prefix: string, parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return `${prefix}_${hash.digest("base64url").slice(0, 32)}`;
}
