import { readFile } from "node:fs/promises";
import type { BuiltinToolContext } from "./shared.ts";
import type { OneBotMessageSegment } from "#services/onebot/types.ts";
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
    pacing: "humanized",
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
  segments?: OneBotMessageSegment[];
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
  segments?: OneBotMessageSegment[];
  onSent?: () => void;
}) {
  const target = context.replyDelivery === "web" ? null : parseSessionTarget(context.lastMessage.sessionId);
  if (context.replyDelivery !== "web" && !target) {
    return JSON.stringify({ error: `unsupported session target: ${context.lastMessage.sessionId}` });
  }
  context.abortSignal?.throwIfAborted();
  const bytes = await readFile(input.absolutePath);
  if (input.semanticKind === "audio" && (!bytes.length || bytes.length > context.config.chatFiles.maxUploadBytes)) {
    throw new Error("发送音频为空或超过资产大小限制");
  }
  context.abortSignal?.throwIfAborted();
  const segments: OneBotMessageSegment[] = input.segments ?? [{
    type: input.semanticKind === "audio" ? "record" : "image",
    data: {
      file: `base64://${bytes.toString("base64")}`,
      ...(input.semanticKind === "emoji" ? { sub_type: 1, summary: "[表情]" } : {})
    }
  }];
  const appendTranscript = (delivery: "web" | "onebot", messageId: number | null) => {
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
    const payload = await context.oneBotClient.sendMessage({ ...target, message: segments });
    appendTranscript("onebot", recordDeliveredMessage(context, input.previewText, payload.data?.message_id));
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
