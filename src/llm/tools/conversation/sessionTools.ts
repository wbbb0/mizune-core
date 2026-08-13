import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { getNumberArg, getStringArg } from "../core/toolArgHelpers.ts";
import { conversationContextPolicy, keepRawUnlessLargePolicy, stateChangePolicy } from "../core/resultObservationPresets.ts";
import { getSessionModeDefinition, sessionModeSupportsChatType } from "#modes/registry.ts";
import {
  sessionBotProfileFields,
  sessionBotProfileSchema,
  type SessionBotProfile,
  type SessionBotProfileField
} from "#conversation/session/sessionBotProfile.ts";

export const sessionToolDescriptors: ToolDescriptor[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "get_current_chat_identity",
        description: "读取只在当前聊天生效的 bot 身份覆盖。",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      }
    },
    resultObservation: keepRawUnlessLargePolicy({ preserveRecentRawCount: 1 })
  },
  {
    definition: {
      type: "function",
      function: {
        name: "patch_current_chat_identity",
        description: "按用户明确要求更新当前聊天中的 bot 身份；只修改提供的字段，不影响其他聊天。",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "当前聊天中使用的名字" },
            identity: { type: "string", description: "身份定位、社会角色或自我理解" },
            background: { type: "string", description: "只在当前聊天成立的背景" },
            temperament: { type: "string", description: "只在当前聊天覆盖的性格表现" },
            voiceStyle: { type: "string", description: "只在当前聊天覆盖的语气和表达方式" }
          },
          additionalProperties: false
        }
      }
    },
    resultObservation: stateChangePolicy()
  },
  {
    definition: {
      type: "function",
      function: {
        name: "clear_current_chat_identity",
        description: "清除当前聊天的部分或全部 bot 身份覆盖，恢复使用全局 persona 和模式资料。",
        parameters: {
          type: "object",
          properties: {
            fields: {
              type: "array",
              items: { type: "string", enum: [...sessionBotProfileFields] },
              description: "要清除的字段；省略时清除当前聊天的全部身份覆盖"
            }
          },
          additionalProperties: false
        }
      }
    },
    resultObservation: stateChangePolicy()
  },
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
    },
    resultObservation: keepRawUnlessLargePolicy({ preserveRecentRawCount: 1 })
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
    },
    resultObservation: stateChangePolicy()
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
    },
    resultObservation: keepRawUnlessLargePolicy({ preserveRecentRawCount: 0 })
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
    },
    resultObservation: keepRawUnlessLargePolicy({ preserveRecentRawCount: 1 })
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
    },
    resultObservation: conversationContextPolicy()
  }
];

export const sessionToolHandlers: Record<string, ToolHandler> = {
  async get_current_chat_identity(_toolCall, _args, context) {
    const session = context.sessionManager.getSession(context.lastMessage.sessionId);
    return JSON.stringify({
      sessionId: session.id,
      profile: session.botProfile
    });
  },
  async patch_current_chat_identity(_toolCall, args, context) {
    const session = context.sessionManager.getSession(context.lastMessage.sessionId);
    const denied = validateSessionBotProfileWrite(session, context.relationship);
    if (denied) {
      return denied;
    }
    const parsed = sessionBotProfileSchema.safeParse(args);
    if (!parsed.success) {
      return JSON.stringify({ error: parsed.error.issues[0]?.message ?? "Invalid chat identity" });
    }
    if (!sessionBotProfileFields.some((field) => Boolean(parsed.data[field]?.trim()))) {
      return JSON.stringify({ error: "At least one non-empty identity field is required" });
    }
    let profile: SessionBotProfile | null;
    try {
      profile = context.sessionManager.patchBotProfile(session.id, parsed.data);
    } catch (error) {
      return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
    }
    context.persistSession?.(session.id, "session_bot_profile_patched_by_tool");
    return JSON.stringify({
      ok: true,
      sessionId: session.id,
      profile,
      instruction: "本轮后续回复立即按更新后的当前聊天身份表达。"
    });
  },
  async clear_current_chat_identity(_toolCall, args, context) {
    const session = context.sessionManager.getSession(context.lastMessage.sessionId);
    const denied = validateSessionBotProfileWrite(session, context.relationship);
    if (denied) {
      return denied;
    }
    const fields = parseSessionBotProfileFields(args);
    if (fields instanceof Error) {
      return JSON.stringify({ error: fields.message });
    }
    const profile = context.sessionManager.clearBotProfile(session.id, fields);
    context.persistSession?.(session.id, "session_bot_profile_cleared_by_tool");
    return JSON.stringify({
      ok: true,
      sessionId: session.id,
      profile,
      instruction: "本轮后续回复立即使用清除覆盖后的当前身份。"
    });
  },
  async list_session_modes(_toolCall, _args, context) {
    const modes = (context.listSessionModes?.() ?? []).map((mode) => ({
      id: mode.id,
      title: mode.title,
      description: mode.description,
      allowedChatTypes: mode.allowedChatTypes
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
    const session = context.sessionManager.getSession(context.lastMessage.sessionId);
    if (!sessionModeSupportsChatType(modeId, session.type)) {
      return JSON.stringify({ error: `Session mode ${modeId} does not support ${session.type} chat` });
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
    context.sessionManager.setModeId(context.lastMessage.sessionId, modeId);
    if (modeId === "scenario_host") {
      await context.scenarioHostStateStore.ensureForSession(session);
    }
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

function validateSessionBotProfileWrite(
  session: { type: "private" | "group"; operationMode: { kind: string } },
  relationship: "owner" | "known"
): string | null {
  if (session.operationMode.kind !== "normal") {
    return JSON.stringify({ error: "Chat identity can only be changed during normal conversation" });
  }
  if (session.type === "group" && relationship !== "owner") {
    return JSON.stringify({ error: "Only the bot owner can change identity for a group chat" });
  }
  return null;
}

function parseSessionBotProfileFields(args: unknown): SessionBotProfileField[] | undefined | Error {
  if (typeof args !== "object" || args == null || !("fields" in args)) {
    return undefined;
  }
  const value = (args as { fields?: unknown }).fields;
  if (!Array.isArray(value) || value.length === 0) {
    return new Error("fields must be a non-empty array when provided");
  }
  const allowed = new Set<string>(sessionBotProfileFields);
  const fields = Array.from(new Set(value.map(String)));
  if (fields.some((field) => !allowed.has(field))) {
    return new Error("fields contains an unknown identity field");
  }
  return fields as SessionBotProfileField[];
}
