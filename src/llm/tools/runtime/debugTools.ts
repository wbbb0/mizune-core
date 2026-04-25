import { getPrimaryModelProfile } from "#llm/shared/modelProfiles.ts";
import { getModelRefsForRole } from "#llm/shared/modelRouting.ts";
import { normalizeOneBotMessageId } from "#services/onebot/messageId.ts";
import type { DebugLiteral } from "#conversation/session/sessionTypes.ts";
import { parseChatSessionIdentity } from "#conversation/session/sessionIdentity.ts";
import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { requireOwner } from "../core/shared.ts";
import { getStringArrayArg } from "../core/toolArgHelpers.ts";
import {
  DerivedObservationReader,
  imageCaptionMapFromDerivedObservations
} from "#llm/derivations/derivedObservationReader.ts";

const DEBUG_LITERALS: DebugLiteral[] = [
  "full_system_prompt",
  "history_summary",
  "tools_info",
  "image_captions",
  "user_infos",
  "persona",
  "recent_history",
  "current_batch",
  "live_resources",
  "debug_markers",
  "last_llm_usage",
  "tool_transcript"
];

export const debugToolDescriptors: ToolDescriptor[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "get_runtime_config",
        description: "读取最小运行时摘要，如 app 名称、当前模型和白名单状态。",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      }
    }
  },
  {
    modelVisible: false,
    definition: {
      type: "function",
      function: {
        name: "echo",
        description: "原样回显输入的 JSON，供内部调试。",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: true
        }
      }
    }
  },
  {
    ownerOnly: true,
    debugOnly: true,
    definition: {
      type: "function",
      function: {
        name: "dump_debug_literals",
        description: "仅在调试模式下使用：按 literal 码值把对应调试文本直接发送到当前会话，每个 literal 一条消息，并结束本轮回复。",
        parameters: {
          type: "object",
          properties: {
            literals: {
              type: "array",
              items: {
                type: "string",
                enum: DEBUG_LITERALS
              },
              description: "要输出的调试 literal 列表，按数组顺序逐条发送。"
            }
          },
          required: ["literals"],
          additionalProperties: false
        }
      }
    }
  }
];

export const debugToolHandlers: Record<string, ToolHandler> = {
  async get_runtime_config(_toolCall, _args, context) {
    const mainModelRefs = getModelRefsForRole(context.config, "main_small");
    return JSON.stringify({
      appName: context.config.appName,
      model: getPrimaryModelProfile(context.config, mainModelRefs)?.model ?? null,
      modelRef: mainModelRefs,
      whitelistEnabled: context.config.whitelist.enabled
    });
  },
  async echo(_toolCall, args) {
    return JSON.stringify({ echo: args });
  },
  async dump_debug_literals(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can dump debug literals");
    if (denied) {
      return denied;
    }

    const rawLiterals = getStringArrayArg(args, "literals") ?? [];
    const literals = rawLiterals.filter(isDebugLiteral);
    if (literals.length === 0) {
      return JSON.stringify({ error: "literals must contain at least one supported literal" });
    }

    const bodies = await Promise.all(literals.map((literal) => renderDebugLiteral(literal, context)));
    const sentMessageIds: number[] = [];
    const sessionId = context.lastMessage.sessionId;
    const parsedSession = parseChatSessionIdentity(sessionId);

    for (const body of bodies) {
      if (context.replyDelivery === "web") {
        await context.committedTextSink?.commitText(body);
      } else {
        if (!parsedSession) {
          return JSON.stringify({ error: `unsupported session target: ${sessionId}` });
        }
        const payload = parsedSession.kind === "group"
          ? await context.oneBotClient.sendText({
              groupId: parsedSession.groupId,
              text: body
            })
          : await context.oneBotClient.sendText({
              userId: parsedSession.userId,
              text: body
            });
        const messageId = normalizeOneBotMessageId(payload.data?.message_id);
        if (messageId != null) {
          sentMessageIds.push(messageId);
          context.sessionManager.recordSentMessage(sessionId, {
            messageId,
            text: body,
            sentAt: Date.now()
          });
        }
      }
    }

    context.sessionManager.appendDebugMarker(sessionId, {
      kind: "debug_dump_sent",
      timestampMs: Date.now(),
      literals,
      sentCount: bodies.length,
      note: "debug_literals_dumped"
    });

    return {
      content: JSON.stringify({
        ok: true,
        literals,
        count: bodies.length,
        messageIds: sentMessageIds
      }),
      terminalResponse: {
        text: ""
      }
    };
  }
};

function isDebugLiteral(value: string): value is DebugLiteral {
  return (DEBUG_LITERALS as string[]).includes(value);
}

async function renderDebugLiteral(literal: DebugLiteral, context: Parameters<NonNullable<typeof debugToolHandlers.dump_debug_literals>>[2]): Promise<string> {
  const snapshot = context.debugSnapshot;
  switch (literal) {
    case "full_system_prompt":
      return snapshot?.systemMessages.join("\n\n") || "<none>";
    case "history_summary":
      return snapshot?.historySummary ?? "<none>";
    case "tools_info":
      return JSON.stringify({
        visibleToolNames: snapshot?.visibleToolNames ?? [],
        activeToolsets: snapshot?.activeToolsets ?? [],
        globalRules: snapshot?.globalRules ?? [],
        toolsetRules: snapshot?.toolsetRules ?? [],
        recentToolEvents: snapshot?.recentToolEvents ?? []
      }, null, 2);
    case "image_captions": {
      const imageIds = new Set<string>();
      for (const message of snapshot?.currentBatch ?? []) {
        for (const imageId of message.imageIds) {
          imageIds.add(imageId);
        }
        for (const emojiId of message.emojiIds) {
          imageIds.add(emojiId);
        }
      }
      for (const message of snapshot?.recentHistory ?? []) {
        for (const match of String(message.content).matchAll(/image_id="([^"]+)"/g)) {
          imageIds.add(String(match[1] ?? ""));
        }
      }
      const captionMap = imageIds.size > 0
        ? imageCaptionMapFromDerivedObservations(await new DerivedObservationReader({
          chatFileStore: context.chatFileStore
        }).read({ chatFileIds: Array.from(imageIds) }))
        : new Map<string, string>();
      return JSON.stringify(Array.from(captionMap.entries()).map(([imageId, caption]) => ({ imageId, caption })), null, 2);
    }
    case "user_infos":
      return JSON.stringify({
        currentUser: snapshot?.currentUser ?? null,
        participantProfiles: snapshot?.participantProfiles ?? []
      }, null, 2);
    case "persona":
      return JSON.stringify(snapshot?.persona ?? await context.personaStore.get(), null, 2);
    case "recent_history":
      return JSON.stringify(snapshot?.recentHistory ?? [], null, 2);
    case "current_batch":
      return JSON.stringify(snapshot?.currentBatch ?? [], null, 2);
    case "live_resources":
      return JSON.stringify(snapshot?.liveResources ?? [], null, 2);
    case "debug_markers":
      return JSON.stringify(snapshot?.debugMarkers ?? context.sessionManager.getDebugMarkers(context.lastMessage.sessionId), null, 2);
    case "last_llm_usage":
      return JSON.stringify(snapshot?.lastLlmUsage ?? context.sessionManager.getSessionView(context.lastMessage.sessionId).lastLlmUsage, null, 2);
    case "tool_transcript":
      return JSON.stringify(snapshot?.toolTranscript ?? context.sessionManager.getSessionView(context.lastMessage.sessionId).internalTranscript, null, 2);
    default:
      return "<unsupported>";
  }
}
