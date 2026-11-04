import { hasConnectorCapability, mediaSendCapability } from "#services/messaging/connectorCapabilities.ts";
import { createTranscriptItemId } from "#conversation/session/transcriptMetadata.ts";
import { QqDeliveryError } from "#services/qqOfficial/types.ts";
import { INITIAL_MEDIA_WAIT_MS, waitForMediaDelivery, mediaDeliveryResult } from "./mediaDeliveryStatus.ts";
import { DeliveryCoordinator } from "#services/messaging/deliveryCoordinator.ts";
import { stat } from "node:fs/promises";
import type { BuiltinToolContext } from "./shared.ts";
import type { MediaDeliveryInput } from "#services/messaging/mediaDeliveryInput.ts";

interface ChatMediaDeliveryInput {
  absolutePath: string;
  previewText: string;
  sourceName: string | null;
  fileId: string | null;
  fileRef: string | null;
  chatFilePath: string | null;
  sourcePath: string | null;
  toolName: "filesystem_send_to_chat" | "asset_send_to_chat" | "sticker_send";
  mimeType?: string | null;
  sizeBytes?: number | null;
  aiGenerated?: boolean;
  outputExtras: Record<string, string | number>;
}

export function sendImageBytesToChat(context: BuiltinToolContext, input: ChatMediaDeliveryInput & {
  semanticKind?: "image" | "emoji";
  nativeEmoji?: MediaDeliveryInput["nativeEmoji"];
  onSent?: () => void;
}) {
  return sendMediaBytesToChat(context, { ...input, semanticKind: input.semanticKind ?? "image" });
}

export function sendAudioBytesToChat(context: BuiltinToolContext, input: ChatMediaDeliveryInput) {
  return sendMediaBytesToChat(context, { ...input, semanticKind: "audio" });
}

/** Media kinds keep their delivery semantics across OneBot and the local transcript. */
async function sendMediaBytesToChat(context: BuiltinToolContext, input: ChatMediaDeliveryInput & {
  semanticKind: "image" | "emoji" | "audio" | "file";
  nativeEmoji?: MediaDeliveryInput["nativeEmoji"];
  onSent?: () => void;
}) {
  if (!hasConnectorCapability(context.config, { sessionId: context.lastMessage.sessionId, replyDelivery: context.replyDelivery }, mediaSendCapability(input.semanticKind === "emoji" ? "image" : input.semanticKind))) {
    return { content: JSON.stringify({ error: "当前会话不支持发送此类媒体。" }) };
  }
  const sessionId = context.lastMessage.sessionId;
  const deliveryId = createTranscriptItemId();
  const signals = [context.abortSignal, context.outboundSignal].filter((signal): signal is AbortSignal => signal !== undefined);
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  signal?.throwIfAborted();
  const now = Date.now();
  context.sessionManager.appendInternalTranscript(sessionId, {
    id: deliveryId, kind: "outbound_media_message", llmVisible: false, role: "assistant",
    delivery: context.replyDelivery, deliveryStatus: "queued", deliveryUpdatedAtMs: now,
    mediaKind: input.semanticKind, fileId: input.fileId, fileRef: input.fileRef, sourceName: input.sourceName,
    chatFilePath: input.chatFilePath, sourcePath: input.sourcePath,
    ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
    ...(input.sizeBytes !== undefined ? { sizeBytes: input.sizeBytes } : {}),
    ...(input.aiGenerated !== undefined ? { aiGenerated: input.aiGenerated } : {}),
    messageId: null, toolName: input.toolName, captionText: null, timestampMs: now
  });
  context.persistSession?.(sessionId, "media_delivery_queued");
  const patch = (value: import("#conversation/session/mediaDelivery.ts").MediaDeliveryPatch) => {
    const changed = context.sessionManager.patchMediaDelivery(sessionId, deliveryId, value);
    if (changed) context.persistSession?.(sessionId, "media_delivery_updated");
    return changed;
  };
  let lease: ReturnType<NonNullable<BuiltinToolContext["beginExternalDelivery"]>> | undefined;
  let barrierFailed = false;
  try { lease = context.replyDelivery === "web" ? undefined : context.beginExternalDelivery?.(); }
  catch {
    barrierFailed = true;
    patch(signal?.aborted
      ? { deliveryStatus: "cancelled", deliveryError: { stage: "prepare", code: "cancelled_before_send", message: "发送前已取消。" } }
      : { deliveryStatus: "failed", deliveryError: { stage: "prepare", code: "delivery_barrier_failed", message: "发送准备失败，未提交此媒体。" } });
  }
  let submitted = false;
  const enqueue = () => context.messageQueue.enqueueText({
    sessionId, text: input.previewText, pacing: context.sessionManager.getSession(sessionId).pacingPreferences.outbound,
    ...(context.outboundSignal ? { abortSignals: [context.outboundSignal] } : {}),
    ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}),
    send: async () => {
      // A reset/clear may remove the record while it waits. Do not send or recreate it.
      if (!patch({ deliveryStatus: "sending" })) return;
      await lease?.ready;
      if (!context.sessionManager.getMediaDelivery(sessionId, deliveryId)) return;
      signal?.throwIfAborted();
      const file = await stat(input.absolutePath);
      if (!file.isFile()) throw new Error("media_file_unavailable");
      if (input.semanticKind === "audio" && (!file.size || file.size > context.config.chatFiles.maxUploadBytes)) throw new Error("media_size_limit");
      signal?.throwIfAborted();
      let reference: import("#services/messaging/deliveryCoordinator.ts").DeliveryReference | undefined;
      if (context.replyDelivery !== "web") {
        if (!context.sessionManager.getMediaDelivery(sessionId, deliveryId)) return;
        submitted = true;
        reference = await (context.messaging ?? new DeliveryCoordinator(context.oneBotClient)).sendMedia({
          sessionId, replyContext: context.replyContext, signal
        }, { filePath: input.absolutePath, kind: input.semanticKind,
          ...(input.nativeEmoji ? { nativeEmoji: input.nativeEmoji } : {}), name: input.sourceName });
      }
      if (patch({ deliveryStatus: "accepted", messageId: reference?.messageId ?? null })) {
        if (reference) context.sessionManager.recordSentMessage(sessionId, { messageId: reference.messageId, text: input.previewText, sentAt: Date.now() });
        try { input.onSent?.(); } catch { /* A bookkeeping failure must never replay an accepted send. */ }
      }
    }
  });
  let completion: Promise<boolean>;
  try { completion = barrierFailed ? Promise.resolve(false) : enqueue(); }
  catch (error) { completion = Promise.reject(error); }
  void completion.then(sent => {
    if (!sent) patch({ deliveryStatus: "cancelled", deliveryError: { stage: "prepare", code: "cancelled_before_send", message: "发送前已取消。" } });
  }).catch((error: unknown) => {
    const notSubmitted = error instanceof QqDeliveryError ? error.messageStatus === "not_submitted" : !submitted;
    const cancelled = notSubmitted && signal?.aborted;
    const unknown = error instanceof QqDeliveryError ? error.messageStatus === "unknown" : submitted;
    const code = error instanceof QqDeliveryError && /^[a-zA-Z0-9_:-]{1,80}$/.test(error.code) ? error.code : cancelled ? "cancelled_before_send" : "media_delivery_failed";
    patch({ deliveryStatus: cancelled ? "cancelled" : unknown ? "unknown" : "failed", deliveryError: {
      stage: error instanceof QqDeliveryError && error.stage === "upload" ? "upload" : submitted ? "message" : "prepare", code,
      message: cancelled ? "发送前已取消。" : unknown ? "平台是否接受此媒体尚不确定，请勿自动重发。" : "媒体发送失败，平台未确认接受。"
    } });
  }).finally(() => lease?.settle());
  const item = await waitForMediaDelivery(context.sessionManager, sessionId, deliveryId, INITIAL_MEDIA_WAIT_MS);
  return { content: JSON.stringify({ ...input.outputExtras,
    ...(input.fileRef ? { asset_ref: input.fileRef } : {}), ...(input.fileId ? { file_id: input.fileId } : {}),
    ...(input.sourcePath ? { path: input.sourcePath } : {}), deliveredAs: input.semanticKind,
    ...mediaDeliveryResult(item, deliveryId) }) };
}

export function sendFileBytesToChat(context: BuiltinToolContext, input: ChatMediaDeliveryInput) {
  if (!hasConnectorCapability(context.config, { sessionId: context.lastMessage.sessionId, replyDelivery: context.replyDelivery }, "media.file.send")) {
    return Promise.resolve({ content: JSON.stringify({ ok: false, deliveredAs: "unsupported", error: "当前 OneBot 提供方不支持发送普通文件，需要 onebot.provider=napcat。" }) });
  }
  return sendMediaBytesToChat(context, { ...input, semanticKind: "file" });
}
