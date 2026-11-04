import { DeliveryCoordinator, type DeliveryReference } from "#services/messaging/deliveryCoordinator.ts";
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
import { NativeStreamDelivery } from "./nativeStreamDelivery.ts";

export interface GenerationOutboundInput {
  sessionId: string;
  responseEpoch: number;
  abortController: AbortController;
  responseAbortController: AbortController;
  sendTarget: GenerationSendTarget;
  committedTextSink?: GenerationCommittedTextSink | undefined;
  isCurrent?: (() => boolean) | undefined;
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

  const messaging = deps.messaging ?? new DeliveryCoordinator(oneBotClient);
  const nativeStreaming = input.sendTarget.delivery === "qq_official" && input.sendTarget.chatType === "private";
  const appendAccepted = (text: string, deliveryRef?: DeliveryReference) => {
    if (!text || input.isCurrent?.() === false) return;
    const appended = sessionManager.appendHistoryIfResponseEpochMatches(input.sessionId, input.responseEpoch, {
      chatType: input.sendTarget.chatType, userId: input.sendTarget.userId,
      senderName: input.sendTarget.senderName, text, ...(deliveryRef ? { deliveryRef } : {})
    }, Date.now());
    if (!appended) return;
    if (deliveryRef) sessionManager.recordSentMessage(input.sessionId, { messageId: deliveryRef.messageId, text, sentAt: Date.now() });
    sessionManager.appendActiveAssistantResponseChunkIfResponseEpochMatches(input.sessionId, input.responseEpoch, {
      chatType: input.sendTarget.chatType, userId: input.sendTarget.userId, senderName: input.sendTarget.senderName
    }, text, Date.now());
    persistSession(input.sessionId, "assistant_chunk_accepted");
  };
  const resolvePacing = (): GenerationDeliveryPacing => sessionManager.getPacingPreferences(input.sessionId).outbound;
  const native = new NativeStreamDelivery({
    isCurrent: input.isCurrent,
    // A previous response's failed media must finish before this response, but cannot poison a fresh reply permit.
    initialBarrier: (messageQueue.getDrainPromise(input.sessionId) ?? Promise.resolve()).catch(() => undefined),
    signals: () => {
      const outbound = sessionManager.getOutboundAbortSignal(input.sessionId);
      return [input.abortController.signal, input.responseAbortController.signal, ...(outbound ? [outbound] : [])];
    },
    captureOpen: () => {
      const replyContext = input.sendTarget.replyContext;
      return () => {
        if (input.isCurrent?.() === false) throw new Error("当前回复已被更新的会话取代。");
        return messaging.openTextStream({ sessionId: input.sessionId, replyContext });
      };
    },
    scheduleStart: (text, signal, send) => messageQueue.enqueueText({
      sessionId: `native-stream-start:${input.sessionId}`, text, pacing: resolvePacing(), abortSignal: signal, send
    }),
    accepted: appendAccepted,
    onCloseError: error => logger.warn({ error, sessionId: input.sessionId }, "native_stream_close_failed")
  });
  const appendNativeDelta = (delta: string) => native.append(delta);
  let hasSentAssistantChunk = false;

  const enqueueChunk = async (
    chunk: string,
    options?: {
      joinWithDoubleNewline?: boolean | undefined;
    }
  ): Promise<boolean> => {
    if (nativeStreaming) {
      // Model deltas have already entered the native stream. Only a final-only or standalone body needs submission here.
      const trimmed = native.text.trim();
      const body = chunk.trim();
      if (!trimmed) appendNativeDelta(chunk);
      else if (body.startsWith(trimmed)) appendNativeDelta(body.slice(trimmed.length));
      else if (!trimmed.endsWith(body)) appendNativeDelta(`\n\n${chunk}`);
      hasSentAssistantChunk = true;
      return true;
    }
    // 在异步渲染前捕获信号，旧片段不能借用消费插话后创建的新信号。
    const outboundSignal = sessionManager.getOutboundAbortSignal(input.sessionId);
    if (outboundSignal?.aborted) return false;
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
      deliveryRef?: DeliveryReference
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
      return appended;
    };

    return await messageQueue.enqueueText({
      sessionId: input.sessionId,
      text: deliveryText,
      pacing: resolvePacing(),
      abortSignals: [input.abortController.signal, input.responseAbortController.signal, ...(outboundSignal ? [outboundSignal] : [])],
      send: async () => {
        if (input.isCurrent?.() === false) return;
        if (input.sendTarget.delivery === "web") {
          await input.committedTextSink?.commitText(storedText);
          const sentAt = Date.now();
          appendHistoryChunk(sentAt);
          await appendBufferedChunk();
          return;
        }

        const address = { sessionId: input.sessionId, replyContext: input.sendTarget.replyContext, signal: outboundSignal };
        const deliveryRef = tableDelivery == null
          ? await messaging.sendText(address, deliveryText)
          : await messaging.sendSegments(address, tableDelivery.segments);
        const appended = appendHistoryChunk(Date.now(), deliveryRef);
        if (appended && deliveryRef != null) {
          sessionManager.recordSentMessage(input.sessionId, {
            messageId: deliveryRef.messageId, text: tableDelivery?.sentLogText ?? deliveryText, sentAt: Date.now()
          });
        }
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
    nativeStreaming,
    appendNativeDelta,
    finishStream: () => native.finish(),
    interruptStream: () => native.interrupt(),
    beginExternalDelivery: () => nativeStreaming ? native.beginExternalDelivery() : { ready: Promise.resolve(), settle() {} },
    flushBufferedOutput,
    hasSentAssistantChunk: () => hasSentAssistantChunk,
    getDrainPromise: () => messageQueue.getDrainPromise(input.sessionId)
  };
}
