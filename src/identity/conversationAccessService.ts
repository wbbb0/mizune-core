import type { Logger } from "pino";
import type { OneBotClient } from "#services/onebot/onebotClient.ts";
import type { SessionManager } from "#conversation/session/sessionManager.ts";
import type { GroupMembershipStore } from "./groupMembershipStore.ts";
import type { NpcDirectory } from "./npcDirectory.ts";

export interface AccessibleSessionView {
  id: string;
  type: "private" | "group";
  title: string;
  reason: "self_private" | "npc_private" | "shared_group";
  lastActiveAt: number;
  historySummaryPreview: string | null;
  recentMessageCount: number;
}

function parseSessionId(sessionId: string): { type: "private" | "group"; userId?: string; groupId?: string } | null {
  if (sessionId.startsWith("private:")) {
    return {
      type: "private",
      userId: sessionId.slice("private:".length)
    };
  }
  if (sessionId.startsWith("group:")) {
    return {
      type: "group",
      groupId: sessionId.slice("group:".length)
    };
  }
  return null;
}

export class ConversationAccessService {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly oneBotClient: OneBotClient,
    private readonly npcDirectory: NpcDirectory,
    private readonly membershipStore: GroupMembershipStore,
    private readonly logger: Logger
  ) {}

  async canAccessSession(requesterUserId: string, sessionId: string): Promise<AccessibleSessionView | null> {
    const parsed = parseSessionId(sessionId);
    if (!parsed) {
      return null;
    }

    const session = this.sessionManager.listSessions().find((item) => item.id === sessionId);
    if (!session) {
      return null;
    }

    if (parsed.type === "private") {
      if (parsed.userId === requesterUserId) {
        return this.toView(session, parsed.userId ?? sessionId, "self_private");
      }
      if (parsed.userId && this.npcDirectory.isNpc(parsed.userId)) {
        return this.toView(session, parsed.userId, "npc_private");
      }
      return null;
    }

    if (!parsed.groupId) {
      return null;
    }
    const isShared = await this.isSharedGroup(parsed.groupId, requesterUserId);
    if (!isShared) {
      return null;
    }
    return this.toView(session, `群 ${parsed.groupId}`, "shared_group");
  }

  async listAccessibleSessions(requesterUserId: string, query = ""): Promise<AccessibleSessionView[]> {
    const normalizedQuery = query.trim().toLowerCase();
    const sessions = this.sessionManager.listSessions();
    const results: AccessibleSessionView[] = [];
    for (const session of sessions) {
      const visible = await this.canAccessSession(requesterUserId, session.id);
      if (!visible) {
        continue;
      }
      if (!normalizedQuery) {
        results.push(visible);
        continue;
      }
      const haystacks = [
        visible.id,
        visible.title,
        visible.historySummaryPreview ?? ""
      ];
      if (haystacks.some((value) => value.toLowerCase().includes(normalizedQuery))) {
        results.push(visible);
      }
    }
    return results
      .sort((left, right) => right.lastActiveAt - left.lastActiveAt)
      .slice(0, 20);
  }

  async isSharedGroup(groupId: string, userId: string): Promise<boolean> {
    const cached = await this.membershipStore.get(groupId, userId);
    if (cached != null) {
      return cached;
    }

    try {
      const member = await this.oneBotClient.getGroupMemberInfo(groupId, userId);
      const isMember = Boolean(member);
      await this.membershipStore.remember(groupId, userId, isMember);
      return isMember;
    } catch (error: unknown) {
      this.logger.info(
        {
          groupId,
          userId,
          error: error instanceof Error ? error.message : String(error)
        },
        "shared_group_check_failed"
      );
      await this.membershipStore.remember(groupId, userId, false);
      return false;
    }
  }

  async recordSeenGroupMember(groupId: string, userId: string): Promise<void> {
    await this.membershipStore.rememberSeen(groupId, userId);
  }

  private toView(
    session: ReturnType<SessionManager["listSessions"]>[number],
    title: string,
    reason: AccessibleSessionView["reason"]
  ): AccessibleSessionView {
    return {
      id: session.id,
      type: session.type,
      title,
      reason,
      lastActiveAt: session.lastActiveAt,
      historySummaryPreview: session.historySummary?.slice(0, 120) ?? null,
      recentMessageCount: this.sessionManager.getLlmVisibleHistory(session.id).length
    };
  }
}
