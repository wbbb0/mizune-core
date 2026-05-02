import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { getStringArg } from "../core/toolArgHelpers.ts";
import { stateChangePolicy } from "../core/resultObservationPresets.ts";
import { parseChatSessionIdentity } from "#conversation/session/sessionIdentity.ts";
import { normalizeOneBotMessageId } from "#services/onebot/messageId.ts";

export const setupDraftToolDescriptors: ToolDescriptor[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "send_setup_draft",
        description: "将当前收集到的设定内容格式化后作为独立消息发送给用户，供用户核对。只在 setup 或 config 草稿阶段使用。",
        parameters: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "要发送的草稿内容，纯文本格式。"
            }
          },
          required: ["content"],
          additionalProperties: false
        }
      }
    },
    resultObservation: stateChangePolicy()
  }
];

export const setupDraftToolHandlers: Record<string, ToolHandler> = {
  async send_setup_draft(_toolCall, args, context) {
    const content = getStringArg(args, "content").trim();
    if (!content) {
      return JSON.stringify({ error: "content is required" });
    }
    const sessionId = context.lastMessage.sessionId;
    const session = context.sessionManager.getSession(sessionId);
    context.messageQueue.enqueueTextDetached({
      sessionId,
      text: content,
      pacing: context.replyDelivery === "web" ? "immediate" : "humanized",
      send: async () => {
        if (context.replyDelivery === "web") {
          await context.committedTextSink?.commitText(content);
          context.sessionManager.appendAssistantHistory(sessionId, {
            chatType: session.type,
            userId: context.lastMessage.userId,
            senderName: context.lastMessage.senderName,
            text: content
          });
          return;
        }

        const parsedSession = parseChatSessionIdentity(sessionId);
        if (!parsedSession) {
          throw new Error(`unsupported session target: ${sessionId}`);
        }
        const sendTarget = parsedSession.kind === "private"
          ? { userId: parsedSession.userId, text: content }
          : { groupId: parsedSession.groupId, text: content };
        const payload = await context.oneBotClient.sendText(sendTarget);
        const messageId = normalizeOneBotMessageId(payload.data?.message_id);
        if (messageId != null) {
          context.sessionManager.recordSentMessage(sessionId, {
            messageId,
            text: content,
            sentAt: Date.now()
          });
        }
        context.sessionManager.appendAssistantHistory(sessionId, {
          chatType: session.type,
          userId: context.lastMessage.userId,
          senderName: context.lastMessage.senderName,
          text: content,
          ...(messageId != null ? {
            deliveryRef: {
              platform: "onebot" as const,
              messageId
            }
          } : {})
        });
      }
    });
    return JSON.stringify({ ok: true, queued: true, sent: true });
  }
};
