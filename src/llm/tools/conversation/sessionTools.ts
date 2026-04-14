import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { getNumberArg, getStringArg } from "../core/toolArgHelpers.ts";
import { getSessionModeDefinition } from "#modes/registry.ts";

export const sessionToolDescriptors: ToolDescriptor[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "list_session_modes",
        description: "列出当前系统中可切换的会话模式。",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      }
    }
  },
  {
    definition: {
      type: "function",
      function: {
        name: "switch_session_mode",
        description: "切换当前会话使用的模式。仅在用户明确要求切换当前会话模式时使用。",
        parameters: {
          type: "object",
          properties: {
            modeId: { type: "string" }
          },
          required: ["modeId"],
          additionalProperties: false
        }
      }
    }
  },
  {
    definition: {
      type: "function",
      function: {
        name: "end_turn_without_reply",
        description: "结束当前轮次且不发送回复。只在最新用户消息明显无需回答时使用。",
        parameters: {
          type: "object",
          properties: {
            reason: { type: "string" }
          },
          additionalProperties: false
        }
      }
    }
  },
  {
    definition: {
      type: "function",
      function: {
        name: "search_accessible_conversations",
        description: "搜索当前用户有权限查看的会话，用于跨会话补充上下文前先定位目标。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" }
          },
          additionalProperties: false
        }
      }
    }
  },
  {
    definition: {
      type: "function",
      function: {
        name: "get_conversation_context",
        description: "按 sessionId 读取一个可访问会话的摘要和最近消息。",
        parameters: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            recentCount: { type: "number" }
          },
          required: ["sessionId"],
          additionalProperties: false
        }
      }
    }
  }
];

export const sessionToolHandlers: Record<string, ToolHandler> = {
  async list_session_modes(_toolCall, _args, context) {
    const modes = (context.listSessionModes?.() ?? []).map((mode) => ({
      id: mode.id,
      title: mode.title,
      description: mode.description
    }));
    return JSON.stringify({
      currentModeId: context.sessionManager.getModeId(context.lastMessage.sessionId),
      modes
    });
  },
  async switch_session_mode(_toolCall, args, context) {
    const modeId = getStringArg(args, "modeId").trim();
    if (!modeId) {
      return JSON.stringify({ error: "modeId is required" });
    }
    const targetMode = getSessionModeDefinition(modeId);
    if (!targetMode) {
      return JSON.stringify({ error: `Unsupported session mode: ${modeId}` });
    }
    const currentModeId = context.sessionManager.getModeId(context.lastMessage.sessionId);
    if (currentModeId === modeId) {
      return JSON.stringify({
        ok: true,
        changed: false,
        currentModeId,
        message: `Current session mode is already ${modeId}`
      });
    }
    const availableModes = context.listSessionModes?.() ?? [];
    if (availableModes.length <= 1) {
      return JSON.stringify({
        ok: false,
        changed: false,
        currentModeId,
        availableModes: availableModes.map((mode) => mode.id),
        message: "Only rp_assistant is currently implemented; no other session mode can be selected yet"
      });
    }
    context.sessionManager.setModeId(context.lastMessage.sessionId, modeId);
    context.persistSession?.(context.lastMessage.sessionId, "session_mode_switched_by_tool");
    return JSON.stringify({
      ok: true,
      changed: true,
      fromModeId: currentModeId,
      toModeId: modeId,
      title: targetMode.title
    });
  },
  async end_turn_without_reply(_toolCall, args) {
    const reason = getStringArg(args, "reason").trim();
    return {
      content: JSON.stringify({
        ok: true,
        ended: true,
        ...(reason ? { reason } : {})
      }),
      terminalResponse: {
        text: ""
      }
    };
  },
  async search_accessible_conversations(_toolCall, args, context) {
    const query = getStringArg(args, "query");
    const sessions = await context.conversationAccess.listAccessibleSessions(context.lastMessage.userId, query);
    return JSON.stringify(sessions);
  },
  async get_conversation_context(_toolCall, args, context) {
    const sessionId = getStringArg(args, "sessionId");
    const recentCount = Math.max(1, Math.min(20, Math.round(getNumberArg(args, "recentCount") ?? 8)));
    if (!sessionId) {
      return JSON.stringify({ error: "sessionId is required" });
    }
    const visible = await context.conversationAccess.canAccessSession(context.lastMessage.userId, sessionId);
    if (!visible) {
      return JSON.stringify({ error: "Conversation is not accessible" });
    }
    const view = context.sessionManager.getSessionView(sessionId);
    return JSON.stringify({
      id: view.id,
      type: view.type,
      title: visible.title,
      reason: visible.reason,
      lastActiveAt: view.lastActiveAt,
      historySummary: view.historySummary,
      recentMessages: context.sessionManager.getLlmVisibleHistory(sessionId).slice(-recentCount)
    });
  }
};
