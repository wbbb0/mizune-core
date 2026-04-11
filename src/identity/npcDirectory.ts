import type { UserStore } from "./userStore.ts";

export interface NpcProfile {
  userId: string;
  preferredAddress?: string;
  gender?: string;
  residence?: string;
  profileSummary?: string;
  relationshipNote?: string;
}

export class NpcDirectory {
  private npcProfiles = new Map<string, NpcProfile>();

  async refresh(userStore: UserStore): Promise<void> {
    const users = await userStore.list();
    this.npcProfiles = new Map(
      users
        .filter((user) => user.specialRole === "npc")
        .map((user) => [user.userId, {
          userId: user.userId,
          ...(user.preferredAddress ? { preferredAddress: user.preferredAddress } : {}),
          ...(user.gender ? { gender: user.gender } : {}),
          ...(user.residence ? { residence: user.residence } : {}),
          ...(user.profileSummary ? { profileSummary: user.profileSummary } : {}),
          ...(user.relationshipNote ? { relationshipNote: user.relationshipNote } : {})
        }])
    );
  }

  isNpc(userId: string): boolean {
    return this.npcProfiles.has(userId);
  }

  listProfiles(): NpcProfile[] {
    return Array.from(this.npcProfiles.values());
  }
}
