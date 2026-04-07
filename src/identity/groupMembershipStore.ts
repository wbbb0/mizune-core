import { join } from "node:path";
import type { Logger } from "pino";
import { FileSchemaStore } from "#data/fileSchemaStore.ts";
import { membershipFileSchema, type MembershipFile } from "./groupMembershipSchema.ts";

const POSITIVE_TTL_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 60 * 1000;

export class GroupMembershipStore {
  private readonly store: FileSchemaStore<typeof membershipFileSchema>;

  constructor(dataDir: string, private readonly logger: Logger) {
    this.store = new FileSchemaStore({
      filePath: join(dataDir, "group-membership-cache.json"),
      schema: membershipFileSchema,
      logger,
      loadErrorEvent: "group_membership_cache_load_failed"
    });
  }

  async init(): Promise<void> {
    await this.readAll();
  }

  async get(groupId: string, userId: string, now = Date.now()): Promise<boolean | null> {
    const data = await this.readAll();
    const entry = data.groups[groupId]?.[userId];
    if (!entry) {
      return null;
    }
    const ttlMs = entry.isMember ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
    if (now - entry.verifiedAt > ttlMs) {
      return null;
    }
    return entry.isMember;
  }

  async remember(groupId: string, userId: string, isMember: boolean, verifiedAt = Date.now()): Promise<void> {
    const data = await this.readAll();
    const next: MembershipFile = {
      version: 1,
      groups: {
        ...data.groups,
        [groupId]: {
          ...(data.groups[groupId] ?? {}),
          [userId]: {
            isMember,
            verifiedAt
          }
        }
      }
    };
    await this.writeAll(next);
  }

  async rememberSeen(groupId: string, userId: string, seenAt = Date.now()): Promise<void> {
    await this.remember(groupId, userId, true, seenAt);
  }

  private async readAll(): Promise<MembershipFile> {
    try {
      return await this.store.readOrDefault({ version: 1, groups: {} });
    } catch (error: unknown) {
      this.logger.warn({ error }, "group_membership_cache_load_failed");
      throw error;
    }
  }

  private async writeAll(data: MembershipFile): Promise<void> {
    await this.store.write(data);
  }
}
