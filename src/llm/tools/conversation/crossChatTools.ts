import type { BuiltinToolContext, ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { requireOperator } from "../core/shared.ts";
import { getStringArg } from "../core/toolArgHelpers.ts";
import { keepRawUnlessLargePolicy, stateChangePolicy } from "../core/resultObservationPresets.ts";
import {
  buildGroupSessionId,
  buildPrivateSessionId,
  parseChatSessionIdentity
} from "#conversation/session/sessionIdentity.ts";
import { resolveInternalUserIdForOneBotPrivateUser } from "#identity/userIdentityResolution.ts";

type SessionListItem = ReturnType<BuiltinToolContext["sessionManager"]["listSessions"]>[number];
type FriendListItem = Awaited<ReturnType<BuiltinToolContext["oneBotClient"]["getFriendList"]>>[number];
type GroupListItem = Awaited<ReturnType<BuiltinToolContext["oneBotClient"]["getGroupList"]>>[number];

export const crossChatToolDescriptors: ToolDescriptor[] = [
  {
    accessLevel: "operator",
    definition: {
      type: "function",
      function: {
        name: "search_chat_targets",
        description: "委派消息前先搜索候选目标会话，可按 userId、昵称、备注、群名或 sessionId 匹配。",
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
    accessLevel: "operator",
    definition: {
      type: "function",
      function: {
        name: "delegate_message_to_chat",
        description: "为另一个会话排队一条自然转达或询问消息。instruction 写给用户看的意图，不要写内部备注。",
        parameters: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            instruction: { type: "string" },
            name: { type: "string" }
          },
          required: ["sessionId", "instruction"],
          additionalProperties: false
        }
      }
    },
    resultObservation: stateChangePolicy()
  }
];

export const crossChatToolHandlers: Record<string, ToolHandler> = {
  async search_chat_targets(_toolCall, args, context) {
    const denied = requireOperator(context, "Only owner or NPC can search cross-chat targets");
    if (denied) {
      return denied;
    }
    const query = getStringArg(args, "query").toLowerCase();
    const sessions = context.sessionManager.listSessions().map((item: SessionListItem) => ({
      sessionId: item.id,
      source: "session",
      title: item.id,
      type: item.type
    }));
    const channelId = context.config.configRuntime.instanceName;
    const friends = (await context.oneBotClient.getFriendList()).map((item: FriendListItem) => ({
      sessionId: buildPrivateSessionId(channelId, String(item.user_id)),
      source: "friend",
      title: `${item.remark ?? item.nickname ?? item.user_id}`,
      type: "private" as const
    }));
    const groups = (await context.oneBotClient.getGroupList()).map((item: GroupListItem) => ({
      sessionId: buildGroupSessionId(channelId, String(item.group_id)),
      source: "group",
      title: `${item.group_name ?? item.group_id}`,
      type: "group" as const
    }));

    const deduped = new Map<string, { sessionId: string; source: string; title: string; type: "private" | "group" }>();
    for (const item of [...sessions, ...friends, ...groups]) {
      if (!deduped.has(item.sessionId)) {
        deduped.set(item.sessionId, item);
      }
    }

    return JSON.stringify(
      Array.from(deduped.values())
        .filter((item) => {
          if (!query) {
            return true;
          }
          return [item.sessionId, item.source, item.title].some((value) => value.toLowerCase().includes(query));
        })
        .slice(0, 20)
    );
  },
  async delegate_message_to_chat(_toolCall, args, context) {
    const denied = requireOperator(context, "Only owner or NPC can delegate messages to another chat");
    if (denied) {
      return denied;
    }
    const sessionId = getStringArg(args, "sessionId");
    const instruction = getStringArg(args, "instruction");
    const name = getStringArg(args, "name");
    if (!sessionId || !instruction) {
      return JSON.stringify({ error: "sessionId and instruction are required" });
    }
    const parsed = parseChatSessionIdentity(sessionId);
    if (!parsed) {
      return JSON.stringify({ error: "Unsupported sessionId" });
    }

    if (parsed.kind === "private") {
      const targetUserId = parsed.userId;
      const targetInternalUserId = context.userIdentityStore
        ? await resolveInternalUserIdForOneBotPrivateUser({
            channelId: parsed.channelId,
            externalUserId: targetUserId,
            userIdentityStore: context.userIdentityStore
          })
        : targetUserId;
      const isNpc = context.npcDirectory.isNpc(targetInternalUserId);
      if (isNpc) {
        return JSON.stringify({ error: "现在不支持这个功能" });
      }
      const friends = await context.oneBotClient.getFriendList();
      const found = friends.some((item: FriendListItem) => String(item.user_id) === targetUserId);
      if (!found) {
        return JSON.stringify({ error: "Private target must be an existing friend" });
      }
      context.sessionManager.ensureSession({
        id: sessionId,
        type: "private"
      });
    } else {
      const targetGroupId = parsed.groupId;
      const groups = await context.oneBotClient.getGroupList();
      const found = groups.some((item: GroupListItem) => String(item.group_id) === targetGroupId);
      if (!found) {
        return JSON.stringify({ error: "Group target must be one joined by the bot" });
      }
      context.sessionManager.ensureSession({
        id: sessionId,
        type: "group"
      });
    }

    const created = await context.scheduledJobStore.create({
      name: name || `delegate:${sessionId}`,
      instruction,
      schedule: {
        kind: "at",
        runAtMs: Date.now() + 1000,
        tz: context.config.scheduler.defaultTimezone
      },
      targets: [{ sessionId }]
    });
    try {
      await context.scheduler.createJob(created);
    } catch (error: unknown) {
      await context.scheduledJobStore.remove(created.id);
      throw error;
    }

    return {
      content: JSON.stringify({
        ok: true,
        jobId: created.id,
        sessionId,
        scheduledAtMs: created.schedule.kind === "at" ? created.schedule.runAtMs : null,
        replyStyleHint: "如果要在当前会话确认这次动作，用第一人称短句表达你马上去问/去转达，不要说系统已经替你问了。"
      }),
      supplementalMessages: [{
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "工具说明：跨会话请求已成功排队。",
              "如果要在当前会话确认这件事，用简短的第一人称下一步表述。",
              "推荐：我马上去问问。 我去帮你问一下。 我去帮你转达。",
              "不要说：我已经让系统去问了。 系统已经替我处理了。 我让系统去问。",
              "除非用户明确追问，否则不要提内部任务、调度器或系统委派。"
            ].join("\n")
          }
        ]
      }]
    };
  }
};
