import { characterRepository } from "../../../character/repository.ts";
import { canReferenceConversation, readConversationContext } from "#conversation/crossConversationContext.ts";
import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { getNumberArg, getStringArg } from "../core/toolArgHelpers.ts";
import { conversationContextPolicy, keepRawUnlessLargePolicy, stateChangePolicy } from "../core/resultObservationPresets.ts";
import { getSessionModeDefinition, sessionModeSupportsChatType } from "#modes/registry.ts";
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
        description: "读取可访问会话的最近聊天。live 包含尚未回复的消息；last_completed_reply 仅返回上次完整回答的发布窗口。不会返回推理或工具执行内容。",
        parameters: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            recentCount: { type: "number" },
            mode: { type: "string", enum: ["live", "last_completed_reply"] }
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
    const characters = characterRepository(context.config.dataDir);
    if (characters.draft(session.id)) return JSON.stringify({ error: "请先确认或取消当前角色配置" });
    context.sessionManager.setModeId(context.lastMessage.sessionId, modeId);
    if (modeId === "scenario_host") {
      await context.scenarioHostStateStore.ensureForSession(session);
    } else if (modeId === "stateful_rp") {
      await context.statefulRpStateStore?.ensureForSession(session);
    }
    const draft = context.relationship === "owner" && session.type === "private" ? characters.ensureSetup(session.id, modeId) : null;
    if (draft) context.sessionManager.setOperationMode(session.id, { kind: "character_config", stage: draft.stage });
    context.persistSession?.(context.lastMessage.sessionId, "session_mode_switched_by_tool");
    return JSON.stringify({
      ok: true,
      changed: true,
      fromModeId: currentModeId,
      toModeId: modeId,
      ...(draft && characters.claimIntroduction(session.id) ? { setupStage: draft.stage, instruction: "已进入角色配置，请在下一次回复主动说明当前阶段、推荐填写内容和 .confirm / .cancel；不要开始游玩。" } : {}),
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
    const target = context.sessionManager.getSession(context.lastMessage.sessionId);
    return JSON.stringify(sessions.filter((session) => target.type !== "group" || session.type === "group"));
  },
  async get_conversation_context(_toolCall, args, context) {
    const sessionId = getStringArg(args, "sessionId");
    const recentCount = Math.max(1, Math.min(20, Math.round(getNumberArg(args, "recentCount") ?? 8)));
    if (!sessionId) {
      return JSON.stringify({ error: "sessionId is required" });
    }
    const mode = getStringArg(args, "mode") || "live";
    if (mode !== "live" && mode !== "last_completed_reply") return JSON.stringify({ error: "Invalid context mode" });
    const visible = await canReferenceConversation({
      reader: context.sessionManager, access: context.conversationAccess,
      requesterUserId: context.lastMessage.userId,
      targetSessionId: context.lastMessage.sessionId, sourceSessionId: sessionId
    });
    if (!visible) return JSON.stringify({ error: "Conversation is not accessible from this chat" });
    return JSON.stringify(readConversationContext(
      context.sessionManager.getSession(sessionId), mode, recentCount,
      context.config.conversation.crossConversation.maxTokens
    ));
  }
};
