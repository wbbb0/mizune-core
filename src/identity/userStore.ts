import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { WhitelistStore } from "./whitelistStore.ts";
import { FileSchemaStore } from "#data/fileSchemaStore.ts";
import { createMemoryEntry, type MemoryEntry } from "#memory/memoryEntry.ts";
import { rotateBackup } from "#utils/rotatingBackup.ts";
import type { Relationship } from "./relationship.ts";
import type { SpecialRole } from "./specialRole.ts";
import { userStoreSchema, type User } from "./userSchema.ts";

function resolveStoredRelationship(whitelistStore: Pick<WhitelistStore, "getOwnerId">, userId: string): Relationship {
  if (whitelistStore.getOwnerId() === userId) {
    return "owner";
  }
  return "known";
}

export class UserStore {
  private readonly filePath: string;
  private readonly store: FileSchemaStore<typeof userStoreSchema>;

  constructor(
    dataDir: string,
    private readonly config: Pick<AppConfig, "backup">,
    private readonly whitelistStore: Pick<WhitelistStore, "getOwnerId">,
    private readonly logger: Logger
  ) {
    this.filePath = join(dataDir, "users.json");
    this.store = new FileSchemaStore({
      filePath: this.filePath,
      schema: userStoreSchema,
      logger,
      loadErrorEvent: "user_store_load_failed"
    });
  }

  async init(): Promise<void> {
    const activeUsers = await this.readRawAll();
    const ownerId = this.whitelistStore.getOwnerId();
    if (ownerId && !activeUsers.some((user) => user.userId === ownerId)) {
      activeUsers.push({
        userId: ownerId,
        memories: [],
        relationship: "owner",
        specialRole: "none",
        createdAt: Date.now()
      });
      await this.writeAll(activeUsers);
      this.logger.info({ ownerId }, "owner_user_initialized");
    }
  }

  async list(): Promise<User[]> {
    return this.readAll();
  }

  async getByUserId(userId: string): Promise<User | null> {
    const users = await this.readAll();
    return users.find((user) => user.userId === userId) ?? null;
  }

  async registerKnownUser(input: {
    userId: string;
    nickname?: string;
    preferredAddress?: string;
    gender?: string;
    residence?: string;
    profileSummary?: string;
    sharedContext?: string;
  }): Promise<User> {
    const users = await this.readAll();
    const existing = users.find((user) => user.userId === input.userId);

    const next: User = {
      userId: input.userId,
      ...(input.nickname ? { nickname: input.nickname } : existing?.nickname ? { nickname: existing.nickname } : {}),
      ...(input.preferredAddress ? { preferredAddress: input.preferredAddress } : existing?.preferredAddress ? { preferredAddress: existing.preferredAddress } : {}),
      ...(input.gender ? { gender: input.gender } : existing?.gender ? { gender: existing.gender } : {}),
      ...(input.residence ? { residence: input.residence } : existing?.residence ? { residence: existing.residence } : {}),
      ...(input.profileSummary ? { profileSummary: input.profileSummary } : existing?.profileSummary ? { profileSummary: existing.profileSummary } : {}),
      ...(input.sharedContext ? { sharedContext: input.sharedContext } : existing?.sharedContext ? { sharedContext: existing.sharedContext } : {}),
      relationship: resolveStoredRelationship(this.whitelistStore, input.userId),
      specialRole: existing?.specialRole ?? "none",
      memories: existing?.memories ?? [],
      createdAt: existing?.createdAt ?? Date.now()
    };

    if (existing) {
      await this.replaceUser(users, next);
    } else {
      users.push(next);
      await this.writeAll(users);
    }
    this.logger.info({ userId: input.userId, relationship: next.relationship }, "known_user_registered");
    return next;
  }

  async setOwner(userId: string): Promise<User> {
    const users = await this.readAll();
    const existing = users.find((user) => user.userId === userId);

    if (!existing) {
      const created: User = {
        userId,
        memories: [],
        relationship: "owner",
        specialRole: "none",
        createdAt: Date.now()
      };
      users.push(created);
      await this.writeAll(users);
      this.logger.info({ userId }, "owner_user_bound");
      return created;
    }

    const updated: User = {
      ...existing,
      relationship: "owner"
    };
    await this.replaceUser(users, updated);
    this.logger.info({ userId }, "owner_user_bound");
    return updated;
  }

  async patchUserProfile(input: {
    userId: string;
    preferredAddress?: string;
    gender?: string;
    residence?: string;
    profileSummary?: string;
    sharedContext?: string;
    nickname?: string;
  }): Promise<User> {
    const users = await this.readAll();
    const existing = users.find((user) => user.userId === input.userId);

    if (!existing) {
      const created: User = {
        userId: input.userId,
        ...(input.nickname ? { nickname: input.nickname } : {}),
        ...(input.preferredAddress ? { preferredAddress: input.preferredAddress } : {}),
        ...(input.gender ? { gender: input.gender } : {}),
        ...(input.residence ? { residence: input.residence } : {}),
        ...(input.profileSummary ? { profileSummary: input.profileSummary } : {}),
        ...(input.sharedContext ? { sharedContext: input.sharedContext } : {}),
        memories: [],
        relationship: resolveStoredRelationship(this.whitelistStore, input.userId),
        specialRole: "none",
        createdAt: Date.now()
      };
      users.push(created);
      await this.writeAll(users);
      this.logger.info({ userId: input.userId }, "user_profile_updated");
      return created;
    }

    const updated: User = {
      ...existing,
      ...(input.nickname ? { nickname: input.nickname } : {}),
      ...(input.preferredAddress ? { preferredAddress: input.preferredAddress } : {}),
      ...(input.gender ? { gender: input.gender } : {}),
      ...(input.residence ? { residence: input.residence } : {}),
      ...(input.profileSummary ? { profileSummary: input.profileSummary } : {}),
      ...(input.sharedContext ? { sharedContext: input.sharedContext } : {})
    };
    await this.replaceUser(users, updated);
    this.logger.info({ userId: input.userId }, "user_profile_updated");
    return updated;
  }

  async touchSeenUser(input: { userId: string; nickname?: string }): Promise<User> {
    const users = await this.readAll();
    const existing = users.find((user) => user.userId === input.userId);

    if (existing) {
      if (input.nickname && existing.nickname !== input.nickname) {
        const updated: User = {
          ...existing,
          nickname: input.nickname
        };
        await this.replaceUser(users, updated);
        return updated;
      }
      return existing;
    }

    if (this.whitelistStore.getOwnerId() && input.userId === this.whitelistStore.getOwnerId()) {
      const created: User = {
        userId: input.userId,
        ...(input.nickname ? { nickname: input.nickname } : {}),
        memories: [],
        relationship: "owner",
        specialRole: "none",
        createdAt: Date.now()
      };
      users.push(created);
      await this.writeAll(users);
      this.logger.info({ userId: created.userId, relationship: created.relationship }, "user_created");
      return created;
    }

    return {
      userId: input.userId,
      ...(input.nickname ? { nickname: input.nickname } : {}),
      memories: [],
      relationship: resolveStoredRelationship(this.whitelistStore, input.userId),
      specialRole: "none",
      createdAt: Date.now()
    };
  }

  async upsertMemory(input: {
    userId: string;
    memoryId?: string;
    title: string;
    content: string;
  }): Promise<User> {
    const users = await this.readAll();
    const existing = users.find((user) => user.userId === input.userId);
    const base = existing ?? {
      userId: input.userId,
      relationship: resolveStoredRelationship(this.whitelistStore, input.userId),
      specialRole: "none" as const,
      createdAt: Date.now(),
      memories: []
    };
    const memories = [...(base.memories ?? [])];
    const nextMemory = createMemoryEntry({
      ...(input.memoryId ? { id: input.memoryId } : {}),
      title: input.title,
      content: input.content
    });
    const targetIndex = memories.findIndex((item) => item.id === nextMemory.id);
    if (targetIndex >= 0) {
      memories[targetIndex] = nextMemory;
    } else {
      memories.push(nextMemory);
    }
    const updated: User = {
      ...base,
      memories
    };
    if (existing) {
      await this.replaceUser(users, updated);
    } else {
      users.push(updated);
      await this.writeAll(users);
    }
    this.logger.info({ userId: input.userId, memoryId: nextMemory.id }, "user_memory_upserted");
    return updated;
  }

  async removeMemory(userId: string, memoryId: string): Promise<User | null> {
    const users = await this.readAll();
    const existing = users.find((user) => user.userId === userId);
    if (!existing) {
      return null;
    }
    const nextMemories = (existing.memories ?? []).filter((item) => item.id !== memoryId);
    if (nextMemories.length === (existing.memories ?? []).length) {
      return existing;
    }
    const updated: User = {
      ...existing,
      memories: nextMemories
    };
    await this.replaceUser(users, updated);
    this.logger.info({ userId, memoryId }, "user_memory_removed");
    return updated;
  }

  async overwriteMemories(userId: string, memories: Array<{ id?: string; title: string; content: string }>): Promise<User> {
    const users = await this.readAll();
    const existing = users.find((user) => user.userId === userId);
    const base = existing ?? {
      userId,
      relationship: resolveStoredRelationship(this.whitelistStore, userId),
      specialRole: "none" as const,
      createdAt: Date.now(),
      memories: []
    };
    const updated: User = {
      ...base,
      memories: memories.map((item) => createMemoryEntry(item))
    };
    if (existing) {
      await this.replaceUser(users, updated);
    } else {
      users.push(updated);
      await this.writeAll(users);
    }
    this.logger.info({ userId, memoryCount: updated.memories.length }, "user_memories_overwritten");
    return updated;
  }

  async setSpecialRole(userId: string, specialRole: SpecialRole): Promise<User> {
    const users = await this.readAll();
    const existing = users.find((user) => user.userId === userId);
    const base = existing ?? {
      userId,
      relationship: resolveStoredRelationship(this.whitelistStore, userId),
      specialRole: "none" as const,
      memories: [],
      createdAt: Date.now()
    };
    const updated: User = {
      ...base,
      specialRole
    };
    if (existing) {
      await this.replaceUser(users, updated);
    } else {
      users.push(updated);
      await this.writeAll(users);
    }
    this.logger.info({ userId, specialRole }, "user_special_role_changed");
    return updated;
  }

  private async readRawAll(): Promise<User[]> {
    try {
      const parsed = await this.store.read();
      if (parsed) {
        return [...parsed];
      }
    } catch (error) {
      this.logger.warn({ error }, "user_store_load_failed");
      throw error;
    }
    await this.writeAll([]);
    return [];
  }

  private async readAll(): Promise<User[]> {
    return this.readRawAll();
  }

  private async replaceUser(users: User[], updated: User): Promise<void> {
    const next = users.map((user) => user.userId === updated.userId ? updated : user);
    await this.writeAll(next);
  }

  private async writeAll(users: User[]): Promise<void> {
    const validated = userStoreSchema.parse(users);
    await this.createBackupIfNeeded();
    await this.store.write(validated);
  }

  private async createBackupIfNeeded(): Promise<void> {
    try {
      await stat(this.filePath);
    } catch (error: unknown) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return;
      }
      throw error;
    }

    await rotateBackup({
      sourceFilePath: this.filePath,
      limit: this.config.backup.profileRotateLimit,
      logger: this.logger
    });
  }
}
