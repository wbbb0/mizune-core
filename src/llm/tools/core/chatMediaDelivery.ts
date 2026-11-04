import { DeliveryCoordinator } from "#services/messaging/deliveryCoordinator.ts";
import { stat } from "node:fs/promises";
import type { BuiltinToolContext } from "./shared.ts";
import type { MediaDeliveryInput } from "#services/messaging/mediaDeliveryInput.ts";
import { parseChatSessionIdentity } from "#conversation/session/sessionIdentity.ts";
import { normalizeOneBotMessageId } from "#services/onebot/messageId.ts";

export function parseSessionTarget(sessionId: string): { userId?: string; groupId?: string } | null {
  const parsed = parseChatSessionIdentity(sessionId);
  if (!parsed) {
    return null;
  }
  return parsed.kind === "private"
    ? { userId: parsed.userId }
    : { groupId: parsed.groupId };
}

export function enqueueToolSend(
  context: BuiltinToolContext,
  previewText: string,
  send: () => Promise<void>
): void {
  context.messageQueue.enqueueTextDetached({
    sessionId: context.lastMessage.sessionId,
    text: previewText,
    pacing: context.sessionManager.getSession(context.lastMessage.sessionId).pacingPreferences.outbound,
    ...(context.outboundSignal ? { abortSignals: [context.outboundSignal] } : {}),
    send,
    ...(context.abortSignal ? { abortSignal: context.abortSignal } : {})
  });
}

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
  outputExtras: Record<string, string>;
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
  semanticKind: "image" | "emoji" | "audio";
  nativeEmoji?: MediaDeliveryInput["nativeEmoji"];
  onSent?: () => void;
}) {
  const target = context.replyDelivery === "web" ? null : parseSessionTarget(context.lastMessage.sessionId);
  if (context.replyDelivery !== "web" && !target) {
    return JSON.stringify({ error: `unsupported session target: ${context.lastMessage.sessionId}` });
  }
  context.abortSignal?.throwIfAborted();
  const file = await stat(input.absolutePath);
  if (!file.isFile()) throw new Error("发送的媒体不是普通文件。");
  if (input.semanticKind === "audio" && (!file.size || file.size > context.config.chatFiles.maxUploadBytes)) {
    throw new Error("发送音频为空或超过资产大小限制");
  }
  context.abortSignal?.throwIfAborted();
  const appendTranscript = (delivery: "web" | "onebot" | "qq_official", messageId: number | string | null) => {
    context.sessionManager.appendInternalTranscript(context.lastMessage.sessionId, {
      kind: "outbound_media_message",
      llmVisible: false,
      role: "assistant",
      delivery,
      mediaKind: input.semanticKind,
      fileId: input.fileId,
      fileRef: input.fileRef,
      sourceName: input.sourceName,
      chatFilePath: input.chatFilePath,
      sourcePath: input.sourcePath,
      ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
      ...(input.sizeBytes !== undefined ? { sizeBytes: input.sizeBytes } : {}),
      ...(input.aiGenerated !== undefined ? { aiGenerated: input.aiGenerated } : {}),
      messageId,
      toolName: input.toolName,
      captionText: null,
      timestampMs: Date.now()
    });
    input.onSent?.();
  };
  enqueueToolSend(context, input.previewText, async () => {
    if (context.replyDelivery === "web") {
      appendTranscript("web", null);
      return;
    }
    if (!target) throw new Error(`unsupported session target: ${context.lastMessage.sessionId}`);
    await context.beforeExternalDelivery?.();
    context.outboundSignal?.throwIfAborted();
    const reference = await (context.messaging ?? new DeliveryCoordinator(context.oneBotClient)).sendMedia({
      sessionId: context.lastMessage.sessionId, replyContext: context.replyContext, signal: context.outboundSignal
    }, { filePath: input.absolutePath, kind: input.semanticKind, ...(input.nativeEmoji ? { nativeEmoji: input.nativeEmoji } : {}), name: input.sourceName });
    if (reference) context.sessionManager.recordSentMessage(context.lastMessage.sessionId, {
      messageId: reference.messageId, text: input.previewText, sentAt: Date.now()
    });
    appendTranscript(reference?.platform ?? context.replyDelivery, reference?.messageId ?? null);
  });
  return {
    content: JSON.stringify({
      ok: true,
      ...(input.fileRef ? { asset_ref: input.fileRef } : {}),
      ...(input.fileId ? { file_id: input.fileId } : {}),
      ...(input.sourcePath ? { path: input.sourcePath } : {}),
      ...input.outputExtras,
      deliveredAs: input.semanticKind,
      queued: true
    })
  };
}

export function recordDeliveredMessage(
  context: BuiltinToolContext,
  text: string,
  messageIdValue: unknown
): number | null {
  const messageId = normalizeOneBotMessageId(messageIdValue);
  if (messageId == null) {
    return null;
  }
  context.sessionManager.recordSentMessage(context.lastMessage.sessionId, {
    messageId,
    text,
    sentAt: Date.now()
  });
  return messageId;
}
