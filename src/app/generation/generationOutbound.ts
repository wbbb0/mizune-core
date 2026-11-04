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

  const messaging = deps.messaging ?? new DeliveryCoordinator(oneBotClient);
  const nativeStreaming = input.sendTarget.delivery === "qq_official" && input.sendTarget.chatType === "private";
  let stream: ReturnType<DeliveryCoordinator["openTextStream"]> | undefined;
  const closingStreams = new Set<ReturnType<DeliveryCoordinator["openTextStream"]>>();
  let streamText = "";
  let streamClosing = Promise.resolve();
  let pendingNative = "";
  let nativeStart: Promise<void> | undefined;
  let nativeFailure: unknown;
  let nativeStartController: AbortController | undefined;
  let removeStreamListeners: (() => void) | undefined;
  const appendAccepted = (text: string, deliveryRef?: DeliveryReference) => {
    if (!text) return;
    if (deliveryRef) sessionManager.recordSentMessage(input.sessionId, { messageId: deliveryRef.messageId, text, sentAt: Date.now() });
    sessionManager.appendHistoryIfResponseEpochMatches(input.sessionId, input.responseEpoch, {
      chatType: input.sendTarget.chatType, userId: input.sendTarget.userId,
      senderName: input.sendTarget.senderName, text, ...(deliveryRef ? { deliveryRef } : {})
    }, Date.now());
    sessionManager.appendActiveAssistantResponseChunkIfResponseEpochMatches(input.sessionId, input.responseEpoch, {
      chatType: input.sendTarget.chatType, userId: input.sendTarget.userId, senderName: input.sendTarget.senderName
    }, text, Date.now());
    persistSession(input.sessionId, "assistant_chunk_accepted");
  };
  const closeStream = (interrupted: boolean): Promise<void> => {
    if (interrupted) {
      pendingNative = "";
      nativeStartController?.abort();
      // A normal seal may already be waiting for HTTP. Cancellation must still discard its local pending suffix.
      for (const closing of closingStreams) void closing.interrupt().catch(() => undefined);
    }
    if (nativeStart) return nativeStart.then(() => closeStream(interrupted));
    if (!stream) {
      removeStreamListeners?.();
      removeStreamListeners = undefined;
      streamText = "";
      if (nativeFailure) return Promise.reject(nativeFailure);
      return streamClosing;
    }
    const closing = stream;
    const removeListeners = removeStreamListeners;
    removeStreamListeners = undefined;
    closingStreams.add(closing);
    stream = undefined;
    streamText = "";
    streamClosing = streamClosing.then(async () => {
      try {
        const receipt = await (interrupted ? closing.interrupt() : closing.finish());
        if (receipt?.acceptedText) appendAccepted(receipt.acceptedText, { platform: "qq_official", connectionId: receipt.connectionId, messageId: receipt.messageId });
      } catch (error) {
        const accepted = closing.receipt;
        if (accepted?.acceptedText) appendAccepted(accepted.acceptedText, { platform: "qq_official", connectionId: accepted.connectionId, messageId: accepted.messageId });
        throw error;
      } finally {
        closingStreams.delete(closing);
        removeListeners?.();
      }
    });
    return streamClosing;
  };
  const resolvePacing = (): GenerationDeliveryPacing => sessionManager.getPacingPreferences(input.sessionId).outbound;
  const appendNativeDelta = (delta: string) => {
    const signal = sessionManager.getOutboundAbortSignal(input.sessionId);
    if (!delta || signal?.aborted || input.abortController.signal.aborted || input.responseAbortController.signal.aborted) return;
    if (stream) { stream.append(delta); streamText += delta; return; }
    if (pendingNative.length + delta.length > 1_048_576) throw new Error("原生流待发内容超过上限。");
    pendingNative += delta;
    streamText += delta;
    if (nativeStart) return;
    const replyContext = input.sendTarget.replyContext;
    const startController = new AbortController();
    nativeStartController = startController;
    const signals = [input.abortController.signal, input.responseAbortController.signal, ...(signal ? [signal] : [])];
    const cancel = () => { void closeStream(true).catch(error => logger.warn({ error, sessionId: input.sessionId }, "native_stream_close_failed")); };
    for (const item of signals) item.addEventListener("abort", cancel, { once: true });
    removeStreamListeners = () => { for (const item of signals) item.removeEventListener("abort", cancel); };
    // Delay only the start of a logical stream. Model reading remains independent from the HTTP pump.
    nativeStart = messageQueue.enqueueText({
      sessionId: `native-stream-start:${input.sessionId}`, text: delta, pacing: resolvePacing(), abortSignals: [...signals, startController.signal],
      send: async () => {
        await streamClosing;
        if (startController.signal.aborted || signals.some(item => item.aborted)) return;
        stream = messaging.openTextStream({ sessionId: input.sessionId, replyContext });
        stream.append(pendingNative);
        pendingNative = "";
      }
    }).then(() => undefined).catch((error: unknown) => { nativeFailure = error; throw error; }).finally(() => { nativeStart = undefined; });
    // Errors remain observable by finish/interrupt without becoming unhandled rejections while generating.
    void nativeStart.catch(() => undefined);
  };
  let hasSentAssistantChunk = false;

  const enqueueChunk = async (
    chunk: string,
    options?: {
      joinWithDoubleNewline?: boolean | undefined;
    }
  ): Promise<boolean> => {
    if (nativeStreaming) {
      // Model deltas have already entered the native stream. Only a final-only or standalone body needs submission here.
      const trimmed = streamText.trim();
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
    };

    return await messageQueue.enqueueText({
      sessionId: input.sessionId,
      text: deliveryText,
      pacing: resolvePacing(),
      abortSignals: [input.abortController.signal, input.responseAbortController.signal, ...(outboundSignal ? [outboundSignal] : [])],
      send: async () => {
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
        if (deliveryRef != null) {
          sessionManager.recordSentMessage(input.sessionId, {
            messageId: deliveryRef.messageId, text: tableDelivery?.sentLogText ?? deliveryText, sentAt: Date.now()
          });
        }
        appendHistoryChunk(Date.now(), deliveryRef);
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
    finishStream: () => closeStream(false),
    interruptStream: () => closeStream(true),
    flushBufferedOutput,
    hasSentAssistantChunk: () => hasSentAssistantChunk,
    getDrainPromise: () => messageQueue.getDrainPromise(input.sessionId)
  };
}
