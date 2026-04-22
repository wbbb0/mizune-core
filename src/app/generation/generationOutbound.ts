import { normalizeOneBotMessageId } from "#services/onebot/messageId.ts";
import { sanitizeOutboundText } from "#llm/shared/outboundTextSanitizer.ts";
import { parseChatSessionIdentity } from "#conversation/session/sessionIdentity.ts";
import type { GenerationOutboundDeps } from "./generationRunnerDeps.ts";
import type { GenerationSendTarget } from "./generationExecutor.ts";
import type { GenerationWebOutputCollector } from "./generationTypes.ts";

export interface GenerationOutboundInput {
  sessionId: string;
  responseEpoch: number;
  abortController: AbortController;
  responseAbortController: AbortController;
  sendTarget: GenerationSendTarget;
  webOutputCollector?: GenerationWebOutputCollector | undefined;
}

// Sends outbound assistant text and mirrors successful chunks into session history.
export function createGenerationOutbound(
  deps: GenerationOutboundDeps,
  input: GenerationOutboundInput
) {
  const {
    logger,
    messageQueue,
    oneBotClient,
    sessionManager,
    persistSession
  } = deps;

  let hasSentAssistantChunk = false;

  const resolveOneBotSendTarget = (): { userId?: string; groupId?: string } => {
    const parsedSession = parseChatSessionIdentity(input.sessionId);
    if (parsedSession?.kind === "group") {
      return { groupId: parsedSession.groupId };
    }
    if (parsedSession?.kind === "private") {
      return { userId: parsedSession.userId };
    }
    return input.sendTarget.groupId
      ? { groupId: input.sendTarget.groupId }
      : { userId: input.sendTarget.userId };
  };

  const enqueueChunk = async (
    chunk: string,
    options?: {
      joinWithDoubleNewline?: boolean | undefined;
    }
  ) => {
    const cleaned = sanitizeOutboundText(chunk, {
      stripLeadingMessageHeaders: !hasSentAssistantChunk
    }).trim();
    if (!cleaned) {
      return;
    }
    hasSentAssistantChunk = true;
    const appendBufferedChunk = async () => {
      const buffered = sessionManager.appendActiveAssistantResponseChunkIfResponseEpochMatches(
        input.sessionId,
        input.responseEpoch,
        {
          chatType: input.sendTarget.chatType,
          userId: input.sendTarget.userId,
          senderName: input.sendTarget.senderName
        },
        cleaned,
        Date.now(),
        {
          joinWithDoubleNewline: options?.joinWithDoubleNewline ?? false
        }
      );
      if (!buffered) {
        logger.info(
          { sessionId: input.sessionId, responseEpoch: input.responseEpoch },
          "assistant_chunk_buffer_skipped_response_mismatch"
        );
        return false;
      }
      logger.info(
        {
          sessionId: input.sessionId,
          contentLength: cleaned.length,
          contentPreview: cleaned.slice(0, 120)
        },
        "assistant_chunk_buffered"
      );
      persistSession(input.sessionId, "assistant_chunk_sent");
      return true;
    };

    const appendHistoryChunk = (
      timestampMs: number,
      deliveryRef?: {
        platform: "onebot";
        messageId: number;
      }
    ) => {
      const appended = sessionManager.appendHistoryIfResponseEpochMatches(
        input.sessionId,
        input.responseEpoch,
        {
          chatType: input.sendTarget.chatType,
          userId: input.sendTarget.userId,
          senderName: input.sendTarget.senderName,
          text: cleaned,
          ...(deliveryRef ? { deliveryRef } : {})
        },
        timestampMs
      );
      if (appended) {
        persistSession(input.sessionId, "assistant_chunk_history_appended");
      } else {
        logger.info(
          { sessionId: input.sessionId, responseEpoch: input.responseEpoch },
          "assistant_chunk_history_skipped_response_mismatch"
        );
      }
    };

    await messageQueue.enqueueText({
      sessionId: input.sessionId,
      text: cleaned,
      abortSignals: [input.abortController.signal, input.responseAbortController.signal],
      send: async () => {
        if (input.sendTarget.delivery === "web") {
          await input.webOutputCollector?.append(cleaned);
          const sentAt = Date.now();
          appendHistoryChunk(sentAt);
          await appendBufferedChunk();
          return;
        }

        const payload = await oneBotClient.sendText({
          text: cleaned,
          ...resolveOneBotSendTarget()
        });
        const messageId = normalizeOneBotMessageId(payload.data?.message_id);
        if (messageId != null) {
          sessionManager.recordSentMessage(input.sessionId, {
            messageId,
            text: cleaned,
            sentAt: Date.now()
          });
        }
        appendHistoryChunk(Date.now(), messageId != null ? {
          platform: "onebot",
          messageId
        } : undefined);
        await appendBufferedChunk();
      }
    });
  };

  const flushBufferedOutput = async (summary: string, streamBuffer: string, streamResponse: boolean | undefined) => {
    let remainingBuffer = streamBuffer;
    if (streamResponse !== false) {
      if (remainingBuffer.trim()) {
        await enqueueChunk(remainingBuffer);
        remainingBuffer = "";
      }

      if (summary.trim() && !hasSentAssistantChunk) {
        await enqueueChunk(summary);
      }
      return remainingBuffer;
    }

    if (summary.trim()) {
      await enqueueChunk(summary);
    }
    return remainingBuffer;
  };

  return {
    enqueueChunk,
    flushBufferedOutput,
    hasSentAssistantChunk: () => hasSentAssistantChunk,
    getDrainPromise: () => messageQueue.getDrainPromise(input.sessionId)
  };
}
