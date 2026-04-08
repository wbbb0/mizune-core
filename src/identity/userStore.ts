import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { WhitelistStore } from "./whitelistStore.ts";
import { FileSchemaStore } from "#data/fileSchemaStore.ts";
import { readStructuredFileRaw } from "#data/schema/file.ts";
import { createMemoryEntry, type MemoryEntry } from "#memory/memoryEntry.ts";
import { rotateBackup } from "#utils/rotatingBackup.ts";
import type { Relationship } from "./relationship.ts";
import type { SpecialRole } from "./specialRole.ts";
import { userStoreSchema, type PersistedUser, type User } from "./userSchema.ts";

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
    const users = await this.readRawAll();
    const existing = users.find((user) => user.userId === input.userId);

    const next: PersistedUser = {
      userId: input.userId,
      ...(input.nickname ? { nickname: input.nickname } : existing?.nickname ? { nickname: existing.nickname } : {}),
      ...(input.preferredAddress ? { preferredAddress: input.preferredAddress } : existing?.preferredAddress ? { preferredAddress: existing.preferredAddress } : {}),
      ...(input.gender ? { gender: input.gender } : existing?.gender ? { gender: existing.gender } : {}),
      ...(input.residence ? { residence: input.residence } : existing?.residence ? { residence: existing.residence } : {}),
      ...(input.profileSummary ? { profileSummary: input.profileSummary } : existing?.profileSummary ? { profileSummary: existing.profileSummary } : {}),
      ...(input.sharedContext ? { sharedContext: input.sharedContext } : existing?.sharedContext ? { sharedContext: existing.sharedContext } : {}),
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
    const runtimeUser = toRuntimeUser(this.whitelistStore, next);
    this.logger.info({ userId: input.userId, relationship: runtimeUser.relationship }, "known_user_registered");
    return runtimeUser;
  }

  async setOwner(userId: string): Promise<User> {
    const users = await this.readRawAll();
    const existing = users.find((user) => user.userId === userId);

    if (!existing) {
      const created: PersistedUser = {
        userId,
        memories: [],
        specialRole: "none",
        createdAt: Date.now()
      };
      users.push(created);
      await this.writeAll(users);
      this.logger.info({ userId }, "owner_user_bound");
      return toRuntimeUser(this.whitelistStore, created);
    }

    this.logger.info({ userId }, "owner_user_bound");
    return toRuntimeUser(this.whitelistStore, existing);
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
    const users = await this.readRawAll();
    const existing = users.find((user) => user.userId === input.userId);

    if (!existing) {
      const created: PersistedUser = {
        userId: input.userId,
        ...(input.nickname ? { nickname: input.nickname } : {}),
        ...(input.preferredAddress ? { preferredAddress: input.preferredAddress } : {}),
        ...(input.gender ? { gender: input.gender } : {}),
        ...(input.residence ? { residence: input.residence } : {}),
        ...(input.profileSummary ? { profileSummary: input.profileSummary } : {}),
        ...(input.sharedContext ? { sharedContext: input.sharedContext } : {}),
        memories: [],
        specialRole: "none",
        createdAt: Date.now()
      };
      users.push(created);
      await this.writeAll(users);
      this.logger.info({ userId: input.userId }, "user_profile_updated");
      return toRuntimeUser(this.whitelistStore, created);
    }

    const updated: PersistedUser = {
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
    return toRuntimeUser(this.whitelistStore, updated);
  }

  async touchSeenUser(input: { userId: string; nickname?: string }): Promise<User> {
    const users = await this.readRawAll();
    const existing = users.find((user) => user.userId === input.userId);

    if (existing) {
      if (input.nickname && existing.nickname !== input.nickname) {
        const updated: PersistedUser = {
          ...existing,
          nickname: input.nickname
        };
        await this.replaceUser(users, updated);
        return toRuntimeUser(this.whitelistStore, updated);
      }
      return toRuntimeUser(this.whitelistStore, existing);
    }

    if (this.whitelistStore.getOwnerId() && input.userId === this.whitelistStore.getOwnerId()) {
      const created: PersistedUser = {
        userId: input.userId,
        ...(input.nickname ? { nickname: input.nickname } : {}),
        memories: [],
        specialRole: "none",
        createdAt: Date.now()
      };
      users.push(created);
      await this.writeAll(users);
      const runtimeUser = toRuntimeUser(this.whitelistStore, created);
      this.logger.info({ userId: created.userId, relationship: runtimeUser.relationship }, "user_created");
      return runtimeUser;
    }

    return toRuntimeUser(this.whitelistStore, {
      userId: input.userId,
      ...(input.nickname ? { nickname: input.nickname } : {}),
      memories: [],
      specialRole: "none",
      createdAt: Date.now()
    });
  }

  async upsertMemory(input: {
    userId: string;
    memoryId?: string;
    title: string;
    content: string;
  }): Promise<User> {
    const users = await this.readRawAll();
    const existing = users.find((user) => user.userId === input.userId);
    const base: PersistedUser = existing ? toPersistedUser(existing) : {
      userId: input.userId,
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
    const updated: PersistedUser = {
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
    return toRuntimeUser(this.whitelistStore, updated);
  }

  async removeMemory(userId: string, memoryId: string): Promise<User | null> {
    const users = await this.readRawAll();
    const existing = users.find((user) => user.userId === userId);
    if (!existing) {
      return null;
    }
    const nextMemories = existing.memories.filter((item) => item.id !== memoryId);
    if (nextMemories.length === existing.memories.length) {
      return toRuntimeUser(this.whitelistStore, existing);
    }
    const updated: PersistedUser = {
      ...existing,
      memories: nextMemories
    };
    await this.replaceUser(users, updated);
    this.logger.info({ userId, memoryId }, "user_memory_removed");
    return toRuntimeUser(this.whitelistStore, updated);
  }

  async overwriteMemories(userId: string, memories: Array<{ id?: string; title: string; content: string }>): Promise<User> {
    const users = await this.readRawAll();
    const existing = users.find((user) => user.userId === userId);
    const base: PersistedUser = existing ? toPersistedUser(existing) : {
      userId,
      specialRole: "none" as const,
      createdAt: Date.now(),
      memories: []
    };
    const updated: PersistedUser = {
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
    return toRuntimeUser(this.whitelistStore, updated);
  }

  async setSpecialRole(userId: string, specialRole: SpecialRole): Promise<User> {
    const users = await this.readRawAll();
    const existing = users.find((user) => user.userId === userId);
    const base: PersistedUser = existing ? toPersistedUser(existing) : {
      userId,
      specialRole: "none" as const,
      memories: [],
      createdAt: Date.now()
    };
    const updated: PersistedUser = {
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
    return toRuntimeUser(this.whitelistStore, updated);
  }

  private async readRawAll(): Promise<PersistedUser[]> {
    try {
      const raw = await readStructuredFileRaw(this.filePath);
      if (raw != null) {
        return normalizePersistedUsers(raw);
      }
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        await this.writeAll([]);
        return [];
      }
      this.logger.warn({ error }, "user_store_load_failed");
      throw error;
    }
    await this.writeAll([]);
    return [];
  }

  private async readAll(): Promise<User[]> {
    return (await this.readRawAll()).map((user) => toRuntimeUser(this.whitelistStore, user));
  }

  private async replaceUser(users: Array<User | PersistedUser>, updated: User | PersistedUser): Promise<void> {
    const normalizedUpdated = toPersistedUser(updated);
    const next = users.map((user) => user.userId === updated.userId ? normalizedUpdated : toPersistedUser(user));
    await this.writeAll(next);
  }

  private async writeAll(users: Array<User | PersistedUser>): Promise<void> {
    const validated = userStoreSchema.parse(users.map((user) => toPersistedUser(user)));
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

function normalizePersistedUsers(value: unknown): PersistedUser[] {
  if (!Array.isArray(value)) {
    return userStoreSchema.parse(value);
  }
  return userStoreSchema.parse(value.map((item) => {
    if (typeof item !== "object" || item == null) {
      return item;
    }
    const { relationship: _relationship, ...rest } = item as Record<string, unknown>;
    return rest;
  }));
}

function toRuntimeUser(
  whitelistStore: Pick<WhitelistStore, "getOwnerId">,
  user: PersistedUser
): User {
  return {
    ...user,
    relationship: resolveStoredRelationship(whitelistStore, user.userId)
  };
}

function toPersistedUser(user: User | PersistedUser): PersistedUser {
  const { relationship: _relationship, ...rest } = user as User;
  return rest;
}
