import { normalizeOneBotMessageId } from "#services/onebot/messageId.ts";
import {
  sanitizeOneBotOutboundText,
  sanitizeStoredOutboundText
} from "#llm/shared/outboundTextSanitizer.ts";
import { parseChatSessionIdentity } from "#conversation/session/sessionIdentity.ts";
import type { GenerationOutboundDeps } from "./generationRunnerDeps.ts";
import type { GenerationSendTarget } from "./generationExecutor.ts";
import type {
  GenerationCommittedTextSink,
  GenerationDeliveryPacing
} from "./generationOutputContracts.ts";
import { buildOneBotMarkdownTableDelivery } from "./oneBotMarkdownTableDelivery.ts";

export interface GenerationOutboundInput {
  sessionId: string;
  responseEpoch: number;
  abortController: AbortController;
  responseAbortController: AbortController;
  sendTarget: GenerationSendTarget;
  committedTextSink?: GenerationCommittedTextSink | undefined;
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
  const resolvePacing = (): GenerationDeliveryPacing => input.sendTarget.delivery === "web"
    ? "immediate"
    : sessionManager.getPacingPreferences(input.sessionId).oneBotOutbound;

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
  ): Promise<boolean> => {
    const storedText = sanitizeStoredOutboundText(chunk, {
      stripLeadingMessageHeaders: !hasSentAssistantChunk
    }).trim();
    const tableDelivery = input.sendTarget.delivery === "onebot" && storedText
      ? await buildOneBotMarkdownTableDelivery(storedText)
      : null;
    const deliveryText = tableDelivery?.pacingText ?? (
      input.sendTarget.delivery === "onebot"
        ? sanitizeOneBotOutboundText(storedText).trim()
        : storedText
    );
    if (!storedText || !deliveryText) {
      return false;
    }
    if (tableDelivery?.renderErrors.length) {
      logger.warn(
        {
          sessionId: input.sessionId,
          errors: tableDelivery.renderErrors
        },
        "onebot_markdown_table_render_failed"
      );
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
        storedText,
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
          contentLength: storedText.length,
          contentPreview: storedText.slice(0, 120)
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
          text: storedText,
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

    return await messageQueue.enqueueText({
      sessionId: input.sessionId,
      text: deliveryText,
      pacing: resolvePacing(),
      abortSignals: [input.abortController.signal, input.responseAbortController.signal],
      send: async () => {
        if (input.sendTarget.delivery === "web") {
          await input.committedTextSink?.commitText(storedText);
          const sentAt = Date.now();
          appendHistoryChunk(sentAt);
          await appendBufferedChunk();
          return;
        }

        const target = resolveOneBotSendTarget();
        const payload = tableDelivery == null
          ? await oneBotClient.sendText({ text: deliveryText, ...target })
          : await oneBotClient.sendMessage({ message: tableDelivery.segments, ...target });
        const messageId = normalizeOneBotMessageId(payload.data?.message_id);
        if (messageId != null) {
          sessionManager.recordSentMessage(input.sessionId, {
            messageId,
            text: tableDelivery?.sentLogText ?? deliveryText,
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
