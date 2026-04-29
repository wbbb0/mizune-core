import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { FileSchemaStore } from "#data/fileSchemaStore.ts";
import { readStructuredFileRaw } from "#data/schema/file.ts";
import { detectScopeConflict, type ScopeConflictWarning } from "#memory/memoryCategory.ts";
import { createUserMemoryEntry, type UserMemoryEntry } from "#memory/userMemoryEntry.ts";
import { findBestDuplicateMatch, normalizeTitleForDedup } from "#memory/similarity.ts";
import {
  buildMemoryDedupDetails,
  buildMemoryWriteDiagnostics,
  type MemoryDedupDetails,
  type MemoryWriteAction
} from "#memory/writeResult.ts";
import { rotateBackup } from "#utils/rotatingBackup.ts";
import type { Relationship } from "./relationship.ts";
import type { SpecialRole } from "./specialRole.ts";
import { normalizeUserProfilePatch } from "./userProfile.ts";
import { userStoreSchema, type PersistedUser, type User } from "./userSchema.ts";

function resolveStoredRelationship(userId: string): Relationship {
  if (userId === "owner") {
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
    await this.readRawAll();
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
    preferredAddress?: string;
    gender?: string;
    residence?: string;
    timezone?: string;
    occupation?: string;
    profileSummary?: string;
    relationshipNote?: string;
  }): Promise<User> {
    const users = await this.readRawAll();
    const existing = users.find((user) => user.userId === input.userId);
    const normalizedPatch = normalizeUserProfilePatch(input);

    const next: PersistedUser = {
      userId: input.userId,
      ...(normalizedPatch.preferredAddress ? { preferredAddress: normalizedPatch.preferredAddress } : existing?.preferredAddress ? { preferredAddress: existing.preferredAddress } : {}),
      ...(normalizedPatch.gender ? { gender: normalizedPatch.gender } : existing?.gender ? { gender: existing.gender } : {}),
      ...(normalizedPatch.residence ? { residence: normalizedPatch.residence } : existing?.residence ? { residence: existing.residence } : {}),
      ...(normalizedPatch.timezone ? { timezone: normalizedPatch.timezone } : existing?.timezone ? { timezone: existing.timezone } : {}),
      ...(normalizedPatch.occupation ? { occupation: normalizedPatch.occupation } : existing?.occupation ? { occupation: existing.occupation } : {}),
      ...(normalizedPatch.profileSummary ? { profileSummary: normalizedPatch.profileSummary } : existing?.profileSummary ? { profileSummary: existing.profileSummary } : {}),
      ...(normalizedPatch.relationshipNote ? { relationshipNote: normalizedPatch.relationshipNote } : existing?.relationshipNote ? { relationshipNote: existing.relationshipNote } : {}),
      ...(existing?.specialRole ? { specialRole: existing.specialRole } : {}),
      memories: existing?.memories ?? [],
      createdAt: existing?.createdAt ?? Date.now()
    };

    if (existing) {
      await this.replaceUser(users, next);
    } else {
      users.push(next);
      await this.writeAll(users);
    }
    const runtimeUser = toRuntimeUser(next);
    this.logger.info({ userId: input.userId, relationship: runtimeUser.relationship }, "known_user_registered");
    return runtimeUser;
  }

  async ensureInternalUser(userId: string): Promise<User> {
    const users = await this.readRawAll();
    const existing = users.find((user) => user.userId === userId);

    if (!existing) {
      const created: PersistedUser = {
        userId,
        memories: [],
        createdAt: Date.now()
      };
      users.push(created);
      await this.writeAll(users);
      this.logger.info({ userId }, "user_created");
      return toRuntimeUser(created);
    }

    return toRuntimeUser(existing);
  }

  async patchUserProfile(input: {
    userId: string;
    preferredAddress?: string;
    gender?: string;
    residence?: string;
    timezone?: string;
    occupation?: string;
    profileSummary?: string;
    relationshipNote?: string;
  }): Promise<User> {
    const users = await this.readRawAll();
    const existing = users.find((user) => user.userId === input.userId);
    const normalizedPatch = normalizeUserProfilePatch(input);

    if (!existing) {
      const created: PersistedUser = {
        userId: input.userId,
        ...(normalizedPatch.preferredAddress ? { preferredAddress: normalizedPatch.preferredAddress } : {}),
        ...(normalizedPatch.gender ? { gender: normalizedPatch.gender } : {}),
        ...(normalizedPatch.residence ? { residence: normalizedPatch.residence } : {}),
        ...(normalizedPatch.timezone ? { timezone: normalizedPatch.timezone } : {}),
        ...(normalizedPatch.occupation ? { occupation: normalizedPatch.occupation } : {}),
        ...(normalizedPatch.profileSummary ? { profileSummary: normalizedPatch.profileSummary } : {}),
        ...(normalizedPatch.relationshipNote ? { relationshipNote: normalizedPatch.relationshipNote } : {}),
        memories: [],
        createdAt: Date.now()
      };
      users.push(created);
      await this.writeAll(users);
      this.logger.info({ userId: input.userId }, "user_profile_updated");
      return toRuntimeUser(created);
    }

    const updated: PersistedUser = {
      ...existing,
      ...(normalizedPatch.preferredAddress ? { preferredAddress: normalizedPatch.preferredAddress } : {}),
      ...(normalizedPatch.gender ? { gender: normalizedPatch.gender } : {}),
      ...(normalizedPatch.residence ? { residence: normalizedPatch.residence } : {}),
      ...(normalizedPatch.timezone ? { timezone: normalizedPatch.timezone } : {}),
      ...(normalizedPatch.occupation ? { occupation: normalizedPatch.occupation } : {}),
      ...(normalizedPatch.profileSummary ? { profileSummary: normalizedPatch.profileSummary } : {}),
      ...(normalizedPatch.relationshipNote ? { relationshipNote: normalizedPatch.relationshipNote } : {})
    };
    await this.replaceUser(users, updated);
    this.logger.info({ userId: input.userId }, "user_profile_updated");
    return toRuntimeUser(updated);
  }

  async touchSeenUser(input: { userId: string }): Promise<User> {
    const users = await this.readRawAll();
    const existing = users.find((user) => user.userId === input.userId);

    if (existing) {
      return toRuntimeUser(existing);
    }

    return this.ensureInternalUser(input.userId);
  }

  async upsertMemory(input: {
    userId: string;
    memoryId?: string;
    title: string;
    content: string;
    kind?: UserMemoryEntry["kind"];
    source?: UserMemoryEntry["source"];
    importance?: number;
  }): Promise<{
    user: User;
    item: UserMemoryEntry;
    action: MemoryWriteAction;
    finalAction: "created" | "updated_existing" | "warning_scope_conflict";
    dedup: MemoryDedupDetails;
    warning: ScopeConflictWarning | null;
  }> {
    const users = await this.readRawAll();
    const existing = users.find((user) => user.userId === input.userId);
    const base: PersistedUser = existing ? toPersistedUser(existing) : {
      userId: input.userId,
      createdAt: Date.now(),
      memories: []
    };
    const memories = [...(base.memories ?? [])];
    if (input.memoryId && !memories.some((item) => item.id === input.memoryId)) {
      throw new Error(`Memory ${input.memoryId} not found for user ${input.userId}`);
    }
    const duplicate = input.memoryId
      ? null
      : findBestDuplicateMatch(
          `${normalizeTitleForDedup(input.title)} ${input.content}`,
          memories,
          (item) => `${normalizeTitleForDedup(item.title)} ${item.content}`
        );
    const targetId = input.memoryId || duplicate?.item.id;
    const action = targetId && memories.some((item) => item.id === targetId)
      ? "updated_existing" as const
      : "created" as const;
    const nextMemory = createUserMemoryEntry({
      ...(targetId ? { id: targetId } : {}),
      ...(duplicate ? { createdAt: duplicate.item.createdAt } : {}),
      title: input.title,
      content: input.content,
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.importance !== undefined ? { importance: input.importance } : {})
    });
    const targetIndex = memories.findIndex((item) => item.id === nextMemory.id);
    if (targetIndex >= 0) {
      memories[targetIndex] = { ...nextMemory, createdAt: memories[targetIndex]!.createdAt };
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
    const dedup = buildMemoryDedupDetails({
      explicitId: input.memoryId ?? null,
      duplicateId: duplicate?.item.id ?? null,
      similarityScore: duplicate?.similarityScore ?? null,
      matchedExisting: targetIndex >= 0
    });
    const warning = detectScopeConflict({
      currentScope: "user_memories",
      title: input.title,
      content: input.content
    });
    const diagnostics = buildMemoryWriteDiagnostics({
      targetCategory: "user_memories",
      action,
      dedup,
      warning
    });
    this.logger.info({
      targetCategory: diagnostics.targetCategory,
      userId: input.userId,
      memoryId: nextMemory.id,
      action: diagnostics.action,
      finalAction: diagnostics.finalAction,
      dedupMatchedBy: diagnostics.dedup.matchedBy,
      dedupMatchedExistingId: diagnostics.dedup.matchedExistingId,
      dedupSimilarityScore: diagnostics.dedup.similarityScore,
      rerouteResult: diagnostics.reroute.result,
      rerouteSuggestedScope: diagnostics.reroute.suggestedScope,
      rerouteReason: diagnostics.reroute.reason
    }, "user_memory_upserted");
    if (warning) {
      this.logger.warn({
        targetCategory: "user_memories",
        userId: input.userId,
        memoryId: nextMemory.id,
        suggestedScope: warning.suggestedScope,
        reason: warning.reason
      }, "memory_scope_conflict_detected");
    }
    return {
      user: toRuntimeUser(updated),
      item: nextMemory,
      action,
      finalAction: diagnostics.finalAction,
      dedup,
      warning
    };
  }

  async removeMemory(userId: string, memoryId: string): Promise<User | null> {
    const users = await this.readRawAll();
    const existing = users.find((user) => user.userId === userId);
    if (!existing) {
      return null;
    }
    const nextMemories = existing.memories.filter((item) => item.id !== memoryId);
    if (nextMemories.length === existing.memories.length) {
      return toRuntimeUser(existing);
    }
    const updated: PersistedUser = {
      ...existing,
      memories: nextMemories
    };
    await this.replaceUser(users, updated);
    this.logger.info({ userId, memoryId }, "user_memory_removed");
    return toRuntimeUser(updated);
  }

  async overwriteMemories(userId: string, memories: Array<{
    id?: string;
    title: string;
    content: string;
    kind?: UserMemoryEntry["kind"];
    source?: UserMemoryEntry["source"];
    importance?: number;
    createdAt?: number;
    updatedAt?: number;
    lastUsedAt?: number;
  }>): Promise<User> {
    const users = await this.readRawAll();
    const existing = users.find((user) => user.userId === userId);
    const base: PersistedUser = existing ? toPersistedUser(existing) : {
      userId,
      createdAt: Date.now(),
      memories: []
    };
    const updated: PersistedUser = {
      ...base,
      memories: memories.map((item) => createUserMemoryEntry(item))
    };
    if (existing) {
      await this.replaceUser(users, updated);
    } else {
      users.push(updated);
      await this.writeAll(users);
    }
    this.logger.info({ userId, memoryCount: updated.memories.length }, "user_memories_overwritten");
    return toRuntimeUser(updated);
  }

  async setSpecialRole(userId: string, specialRole: SpecialRole | "none"): Promise<User> {
    const users = await this.readRawAll();
    const existing = users.find((user) => user.userId === userId);
    const base: PersistedUser = existing ? toPersistedUser(existing) : {
      userId,
      memories: [],
      createdAt: Date.now()
    };
    const updated: PersistedUser = specialRole === "none"
      ? (({ specialRole: _sr, ...rest }) => rest)(base as PersistedUser & { specialRole?: SpecialRole })
      : { ...base, specialRole };
    if (existing) {
      await this.replaceUser(users, updated);
    } else {
      users.push(updated);
      await this.writeAll(users);
    }
    this.logger.info({ userId, specialRole }, "user_special_role_changed");
    return toRuntimeUser(updated);
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
    return (await this.readRawAll()).map((user) => toRuntimeUser(user));
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
  return userStoreSchema.parse(value);
}

function toRuntimeUser(
  user: PersistedUser
): User {
  return {
    ...user,
    relationship: resolveStoredRelationship(user.userId)
  };
}

function toPersistedUser(user: User | PersistedUser): PersistedUser {
  const { relationship: _relationship, ...rest } = user as User;
  return rest;
}
