import type { SessionManager } from "#conversation/session/sessionManager.ts";
import type { InternalTranscriptItem } from "#conversation/session/sessionTypes.ts";
import type { ParsedIncomingMessage } from "#services/onebot/types.ts";
import type { OneBotClient } from "#services/onebot/onebotClient.ts";
import type { MediaWorkspace } from "#services/workspace/mediaWorkspace.ts";
import type { GenerationWebOutputCollector } from "#app/generation/generationExecutor.ts";
import type {
  ParsedSendTextBody,
  ParsedWebSessionStreamQuery,
  ParsedWebTurnBody,
  ParsedWebTurnStreamQuery
} from "../routeSupport.ts";
import {
  createWebTurnBroker,
  type WebTurnBroker,
  type WebTurnStreamEvent
} from "./webTurnBroker.ts";
import {
  buildInitialSessionStreamEvents,
  diffSessionStreamEvents,
  type WebSessionStreamEvent,
  type WebSessionStreamSnapshot
} from "./webSessionStream.ts";

export { type WebTurnStreamEvent } from "./webTurnBroker.ts";
export { type WebSessionStreamEvent } from "./webSessionStream.ts";

const WEB_SESSION_STREAM_POLL_MS = 250;

type SessionStreamableState = {
  id: string;
  type: "private" | "group";
  source: "onebot" | "web";
  participantUserId: string;
  participantLabel: string | null;
  pendingMessages: Array<{ receivedAt?: number }>;
  pendingReplyGateWaitPasses: number;
  debounceTimer: NodeJS.Timeout | null;
  isGenerating: boolean;
  isResponding: boolean;
  historyRevision: number;
  mutationEpoch: number;
  lastActiveAt: number;
  internalTranscript: InternalTranscriptItem[];
  recentToolEvents: Array<{ toolName: string }>;
  activeAssistantResponse: { text: string } | null;
};

export interface AdminMessagingService {
  sendInternalTextMessage(body: ParsedSendTextBody): Promise<unknown>;
  startWebSessionTurn(params: { sessionId: string }, body: ParsedWebTurnBody): Promise<{ ok: true; turnId: string }>;
  getWebTurnStream(params: { sessionId: string }, query: ParsedWebTurnStreamQuery): {
    turnId: string;
    initialEvents: WebTurnStreamEvent[];
    subscribe: (listener: (event: WebTurnStreamEvent) => void) => () => void;
  };
  getWebSessionStream(
    params: { sessionId: string },
    query: ParsedWebSessionStreamQuery
  ): Promise<{
    initialEvents: WebSessionStreamEvent[];
    subscribe: (listener: (event: WebSessionStreamEvent) => void) => () => void;
  }>;
}

export function createAdminMessagingService(input: {
  config: {
    onebot: {
      enabled: boolean;
    };
  };
  oneBotClient: Pick<OneBotClient, "sendText">;
  mediaWorkspace: Pick<MediaWorkspace, "getMany">;
  sessionManager: Pick<SessionManager, "getSession" | "hasActiveResponse"> & {
    getSession(sessionId: string): SessionStreamableState;
  };
  handleWebIncomingMessage: (
    incomingMessage: ParsedIncomingMessage,
    options: {
      webOutputCollector: GenerationWebOutputCollector;
      sessionId?: string;
    }
  ) => Promise<void>;
  webTurnBroker?: WebTurnBroker;
}): AdminMessagingService {
  const broker = input.webTurnBroker ?? createWebTurnBroker();

  return {
    async sendInternalTextMessage(body) {
      if (!input.config.onebot.enabled) {
        throw new Error("OneBot is disabled in the current runtime mode");
      }
      return input.oneBotClient.sendText({
        text: body.text,
        ...(body.userId ? { userId: body.userId } : {}),
        ...(body.groupId ? { groupId: body.groupId } : {})
      });
    },

    async startWebSessionTurn(params, body) {
      const session = input.sessionManager.getSession(params.sessionId);
      const senderName = body.senderName ?? body.userId;
      const turnState = broker.create(params.sessionId);

      broker.publish(turnState, {
        type: "ready",
        turnId: turnState.turnId,
        sessionId: params.sessionId,
        timestampMs: Date.now()
      });

      void runWebTurnInBackground({
        sessionManager: input.sessionManager,
        handleWebIncomingMessage: input.handleWebIncomingMessage,
        mediaWorkspace: input.mediaWorkspace,
        broker,
        turnState,
        sessionId: params.sessionId,
        message: {
          userId: body.userId,
          senderName,
          text: body.text,
          imageIds: body.imageIds,
          attachmentIds: body.attachmentIds,
          chatType: session.type,
          ...(session.type === "group" ? { groupId: extractGroupId(params.sessionId) } : {})
        }
      });

      return {
        ok: true,
        turnId: turnState.turnId
      };
    },

    getWebTurnStream(params, query) {
      return broker.getStream(params.sessionId, query.turnId);
    },

    async getWebSessionStream(params, query) {
      const initialSnapshot = await readSessionStreamSnapshot(input, params.sessionId);
      let previousSnapshot = initialSnapshot;

      return {
        initialEvents: buildInitialSessionStreamEvents(initialSnapshot, query),
        subscribe(listener) {
          let closed = false;
          let polling = false;

          const tick = async () => {
            if (closed || polling) {
              return;
            }
            polling = true;
            try {
              const currentSnapshot = await readSessionStreamSnapshot(input, params.sessionId);
              for (const event of diffSessionStreamEvents(previousSnapshot, currentSnapshot)) {
                listener(event);
              }
              previousSnapshot = currentSnapshot;
            } catch {
              // Ignore transient polling failures and let the next tick retry.
            } finally {
              polling = false;
            }
          };

          const timer = setInterval(() => {
            void tick();
          }, WEB_SESSION_STREAM_POLL_MS);
          timer.unref?.();

          return () => {
            closed = true;
            clearInterval(timer);
          };
        }
      };
    }
  };
}

async function runWebTurnInBackground(input: {
  sessionManager: Pick<SessionManager, "getSession" | "hasActiveResponse"> & {
    getSession(sessionId: string): SessionStreamableState;
  };
  mediaWorkspace: Pick<MediaWorkspace, "getMany">;
  handleWebIncomingMessage: (
    incomingMessage: ParsedIncomingMessage,
    options: {
      webOutputCollector: GenerationWebOutputCollector;
      sessionId?: string;
    }
  ) => Promise<void>;
  broker: WebTurnBroker;
  turnState: ReturnType<WebTurnBroker["create"]>;
  sessionId: string;
  message: {
    chatType: "private" | "group";
    userId: string;
    groupId?: string;
    senderName: string;
    text: string;
    imageIds: string[];
    attachmentIds: string[];
  };
}): Promise<void> {
  try {
    const attachments = input.message.attachmentIds.length > 0
      ? (await input.mediaWorkspace.getMany(input.message.attachmentIds)).map((file) => ({
          fileId: file.fileId,
          kind: file.kind,
          source: "web_upload" as const,
          sourceName: file.sourceName,
          mimeType: file.mimeType
        }))
      : [];
    await input.handleWebIncomingMessage({
      chatType: input.message.chatType,
      userId: input.message.userId,
      ...(input.message.groupId ? { groupId: input.message.groupId } : {}),
      senderName: input.message.senderName,
      text: input.message.text,
      images: [],
      audioSources: [],
      audioIds: [],
      emojiSources: [],
      imageIds: input.message.imageIds,
      emojiIds: [],
      attachments,
      forwardIds: [],
      replyMessageId: null,
      mentionUserIds: [],
      mentionedAll: false,
      isAtMentioned: false
    }, {
      sessionId: input.sessionId,
      webOutputCollector: {
        append(chunk) {
          input.broker.publish(input.turnState, {
            type: "chunk",
            turnId: input.turnState.turnId,
            sessionId: input.sessionId,
            chunk,
            timestampMs: Date.now()
          });
        }
      }
    });

    await waitForSessionTurnCompletion(input.sessionManager, input.sessionId, input.turnState.createdAt);
    input.broker.publish(input.turnState, {
      type: "complete",
      turnId: input.turnState.turnId,
      sessionId: input.sessionId,
      response: "",
      chunks: [],
      timestampMs: Date.now()
    });
    input.broker.complete(input.turnState);
  } catch (error: unknown) {
    input.broker.publish(input.turnState, {
      type: "turn_error",
      turnId: input.turnState.turnId,
      sessionId: input.sessionId,
      message: error instanceof Error ? error.message : String(error),
      timestampMs: Date.now()
    });
    input.broker.fail(input.turnState);
  }
}

async function waitForSessionTurnCompletion(
  sessionManager: Pick<SessionManager, "getSession" | "hasActiveResponse"> & {
    getSession(sessionId: string): SessionStreamableState;
  },
  sessionId: string,
  startedAt: number
): Promise<void> {
  const timeoutAt = Date.now() + 300000;
  while (true) {
    const session = sessionManager.getSession(sessionId);
    const hasPendingRecentInput = session.pendingMessages.some((item) => (item.receivedAt ?? 0) >= startedAt);
    const stillWorking = sessionManager.hasActiveResponse(sessionId)
      || session.debounceTimer != null
      || hasPendingRecentInput;

    if (!stillWorking) {
      return;
    }
    if (Date.now() >= timeoutAt) {
      throw new Error("Timed out while waiting for session response");
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  }
}

function extractGroupId(sessionId: string): string {
  if (!sessionId.startsWith("group:")) {
    throw new Error(`Session is not a group session: ${sessionId}`);
  }
  return sessionId.slice("group:".length);
}

async function readSessionStreamSnapshot(
  input: Pick<
    Parameters<typeof createAdminMessagingService>[0],
    "sessionManager"
  >,
  sessionId: string
): Promise<WebSessionStreamSnapshot> {
  const session = input.sessionManager.getSession(sessionId);
  return {
    sessionId,
    mutationEpoch: session.mutationEpoch,
    transcript: [...session.internalTranscript],
    pendingMessageCount: session.pendingMessages.length,
    pendingReplyGateWaitPasses: session.pendingReplyGateWaitPasses,
    hasDebounceTimer: session.debounceTimer != null,
    isGenerating: session.isGenerating,
    isResponding: session.isResponding,
    lastActiveAt: session.lastActiveAt,
    activeAssistantResponseText: session.activeAssistantResponse?.text ?? null,
    lastToolName: session.recentToolEvents.at(-1)?.toolName ?? null
  };
}
