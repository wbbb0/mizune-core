import type { Logger } from "pino";
import type { OneBotClient } from "#services/onebot/onebotClient.ts";
import type { SessionConversationCatalog } from "#conversation/session/sessionCapabilities.ts";
import { parseChatSessionIdentity } from "#conversation/session/sessionIdentity.ts";
import type { SessionState } from "#conversation/session/sessionTypes.ts";
import type { GroupMembershipStore } from "./groupMembershipStore.ts";
import type { NpcDirectory } from "./npcDirectory.ts";
import type { UserIdentityStore } from "./userIdentityStore.ts";
import {
  resolveExternalUserIdForInternalUser,
  resolveInternalUserIdForOneBotPrivateUser
} from "./userIdentityResolution.ts";

export interface AccessibleSessionView {
  id: string;
  type: "private" | "group";
  title: string;
  reason: "self_private" | "npc_private" | "shared_group";
  lastActiveAt: number;
  historySummaryPreview: string | null;
  recentMessageCount: number;
}

export class ConversationAccessService {
  constructor(
    private readonly sessionCatalog: SessionConversationCatalog,
    private readonly oneBotClient: OneBotClient,
    private readonly npcDirectory: NpcDirectory,
    private readonly membershipStore: GroupMembershipStore,
    private readonly userIdentityStore: Pick<UserIdentityStore, "findInternalUserId" | "findIdentityByInternalUserId">,
    private readonly logger: Logger
  ) {}

  async canAccessSession(requesterUserId: string, sessionId: string): Promise<AccessibleSessionView | null> {
    const parsed = parseChatSessionIdentity(sessionId);
    if (!parsed) {
      return null;
    }

    const session = this.sessionCatalog.listSessions().find((item) => item.id === sessionId);
    if (!session) {
      return null;
    }

    if (parsed.kind === "private") {
      const targetInternalUserId = await resolveInternalUserIdForOneBotPrivateUser({
        channelId: parsed.channelId,
        externalUserId: parsed.userId,
        userIdentityStore: this.userIdentityStore
      });
      if (targetInternalUserId === requesterUserId) {
        return this.toView(session, parsed.userId, "self_private");
      }
      if (this.npcDirectory.isNpc(targetInternalUserId)) {
        return this.toView(session, parsed.userId, "npc_private");
      }
      return null;
    }

    const requesterExternalUserId = await resolveExternalUserIdForInternalUser({
      internalUserId: requesterUserId,
      userIdentityStore: this.userIdentityStore
    });
    const isShared = await this.isSharedGroup(parsed.groupId, requesterExternalUserId ?? requesterUserId);
    if (!isShared) {
      return null;
    }
    return this.toView(session, `群 ${parsed.groupId}`, "shared_group");
  }

  async listAccessibleSessions(requesterUserId: string, query = ""): Promise<AccessibleSessionView[]> {
    const normalizedQuery = query.trim().toLowerCase();
    const sessions = this.sessionCatalog.listSessions();
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
    session: SessionState,
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
      recentMessageCount: this.sessionCatalog.getLlmVisibleHistory(session.id).length
    };
  }
}
