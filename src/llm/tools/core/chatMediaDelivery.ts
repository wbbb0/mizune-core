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
    send
  });
}

export async function sendImageBytesToChat(
  context: BuiltinToolContext,
  input: {
    absolutePath: string;
    previewText: string;
    sourceName: string | null;
    fileId: string | null;
    fileRef: string | null;
    chatFilePath: string | null;
    sourcePath: string | null;
    toolName: "filesystem_send_to_chat" | "asset_send_to_chat" | "sticker_send";
    semanticKind?: "image" | "emoji";
    segments?: OneBotMessageSegment[];
    onSent?: () => void;
    outputExtras: Record<string, string>;
  }
) {
  const target = context.replyDelivery === "web" ? null : parseSessionTarget(context.lastMessage.sessionId);
  if (context.replyDelivery !== "web" && !target) {
    return JSON.stringify({ error: `unsupported session target: ${context.lastMessage.sessionId}` });
  }
  const bytes = await readFile(input.absolutePath);
  const segments: OneBotMessageSegment[] = input.segments ?? [{
    type: "image",
    data: {
      file: `base64://${bytes.toString("base64")}`,
      ...(input.semanticKind === "emoji" ? { sub_type: 1, summary: "[表情]" } : {})
    }
  }];
  enqueueToolSend(context, input.previewText, async () => {
    if (context.replyDelivery === "web") {
      context.sessionManager.appendInternalTranscript(context.lastMessage.sessionId, {
        kind: "outbound_media_message",
        llmVisible: false,
        role: "assistant",
        delivery: "web",
        mediaKind: input.semanticKind ?? "image",
        fileId: input.fileId,
        fileRef: input.fileRef,
        sourceName: input.sourceName,
        chatFilePath: input.chatFilePath,
        sourcePath: input.sourcePath,
        messageId: null,
        toolName: input.toolName,
        captionText: null,
        timestampMs: Date.now()
      });
      input.onSent?.();
      return;
    }

    if (!target) {
      throw new Error(`unsupported session target: ${context.lastMessage.sessionId}`);
    }
    const payload = await context.oneBotClient.sendMessage({ ...target, message: segments });
    const messageId = recordDeliveredMessage(context, input.previewText, payload.data?.message_id);
    context.sessionManager.appendInternalTranscript(context.lastMessage.sessionId, {
      kind: "outbound_media_message",
      llmVisible: false,
      role: "assistant",
      delivery: "onebot",
      mediaKind: input.semanticKind ?? "image",
      fileId: input.fileId,
      fileRef: input.fileRef,
      sourceName: input.sourceName,
      chatFilePath: input.chatFilePath,
      sourcePath: input.sourcePath,
      messageId,
      toolName: input.toolName,
      captionText: null,
      timestampMs: Date.now()
    });
    input.onSent?.();
  });
  return {
    content: JSON.stringify({
      ok: true,
      ...(input.fileRef ? { asset_ref: input.fileRef } : {}),
      ...(input.fileId ? { file_id: input.fileId } : {}),
      ...(input.sourcePath ? { path: input.sourcePath } : {}),
      ...input.outputExtras,
      deliveredAs: input.semanticKind ?? "image",
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
