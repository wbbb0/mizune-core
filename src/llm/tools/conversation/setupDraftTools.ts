import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { getStringArg } from "../core/toolArgHelpers.ts";
import { parseChatSessionIdentity } from "#conversation/session/sessionIdentity.ts";

export const setupDraftToolDescriptors: ToolDescriptor[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "send_setup_draft",
        description: "将当前收集到的设定内容格式化后作为独立消息发送给用户，供用户核对。只在初始化阶段使用。",
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
    }
  }
];

export const setupDraftToolHandlers: Record<string, ToolHandler> = {
  async send_setup_draft(_toolCall, args, context) {
    const content = getStringArg(args, "content").trim();
    if (!content) {
      return JSON.stringify({ error: "content is required" });
    }
    const sessionId = context.lastMessage.sessionId;
    const parsedSession = parseChatSessionIdentity(sessionId);
    if (!parsedSession) {
      return JSON.stringify({ error: "unsupported session target" });
    }
    const sendTarget = parsedSession.kind === "private"
      ? { userId: parsedSession.userId, text: content }
      : { groupId: parsedSession.groupId, text: content };
    context.messageQueue.enqueueTextDetached({
      sessionId,
      text: content,
      send: () => context.oneBotClient.sendText(sendTarget).then(() => undefined)
    });
    return JSON.stringify({ ok: true, sent: true });
  }
};
