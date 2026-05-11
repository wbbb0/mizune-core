import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { SqliteDatabase } from "#data/sqlite/sqliteService.ts";
import { StateDatabase } from "#data/state/stateDatabase.ts";
import { detectScopeConflict, type ScopeConflictWarning } from "#memory/memoryCategory.ts";
import { createUserMemoryEntry, type UserMemoryEntry } from "#memory/userMemoryEntry.ts";
import { findBestDuplicateMatch, normalizeTitleForDedup } from "#memory/similarity.ts";
import {
  buildMemoryDedupDetails,
  buildMemoryWriteDiagnostics,
  type MemoryDedupDetails,
  type MemoryWriteAction
} from "#memory/writeResult.ts";
import type { Relationship } from "./relationship.ts";
import type { SpecialRole } from "./specialRole.ts";
import { normalizeUserProfilePatch } from "./userProfile.ts";
import { persistedUserSchema, userStoreSchema, type PersistedUser, type User } from "./userSchema.ts";

function resolveStoredRelationship(userId: string): Relationship {
  if (userId === "owner") {
    return "owner";
  }
  return "known";
}

export class UserStore {
  constructor(
    dataDir: string,
    _config: Pick<AppConfig, "backup">,
    private readonly logger: Logger,
    private readonly stateDatabase = new StateDatabase(dataDir, logger)
  ) {
  }

  async init(): Promise<void> {
    await this.stateDatabase.init();
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
    const existing = await this.getPersistedByUserId(input.userId);
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

    await this.upsertUserCore(next);
    const runtimeUser = toRuntimeUser(next);
    this.logger.info({ userId: input.userId, relationship: runtimeUser.relationship }, "known_user_registered");
    return runtimeUser;
  }

  async ensureInternalUser(userId: string): Promise<User> {
    const existing = await this.getPersistedByUserId(userId);

    if (!existing) {
      const created: PersistedUser = {
        userId,
        memories: [],
        createdAt: Date.now()
      };
      await this.upsertUserCore(created);
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
    const existing = await this.getPersistedByUserId(input.userId);
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
      await this.upsertUserCore(created);
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
    await this.upsertUserCore(updated);
    this.logger.info({ userId: input.userId }, "user_profile_updated");
    return toRuntimeUser(updated);
  }

  async touchSeenUser(input: { userId: string }): Promise<User> {
    const existing = await this.getPersistedByUserId(input.userId);

    if (existing) {
      return toRuntimeUser(existing);
    }

    return this.ensureInternalUser(input.userId);
  }

  async clearLegacyMemories(): Promise<number> {
    await this.stateDatabase.init();
    const memoryCount = (this.stateDatabase.getDb().prepare(`
      SELECT COUNT(*) AS count
      FROM user_memories
    `).get() as { count: number }).count;
    if (memoryCount === 0) {
      return 0;
    }
    this.stateDatabase.getDb().prepare("DELETE FROM user_memories").run();
    this.logger.info({ memoryCount }, "legacy_user_memories_cleared");
    return memoryCount;
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
    const existing = await this.getPersistedByUserId(input.userId);
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
    const storedMemory = targetIndex >= 0
      ? { ...nextMemory, createdAt: memories[targetIndex]!.createdAt }
      : nextMemory;
    if (targetIndex >= 0) {
      memories[targetIndex] = storedMemory;
    } else {
      memories.push(storedMemory);
    }
    const updated: PersistedUser = {
      ...base,
      memories
    };
    await this.upsertMemoryRow(updated.userId, storedMemory);
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
      item: storedMemory,
      action,
      finalAction: diagnostics.finalAction,
      dedup,
      warning
    };
  }

  async removeMemory(userId: string, memoryId: string): Promise<User | null> {
    const existing = await this.getPersistedByUserId(userId);
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
    await this.deleteMemoryRow(userId, memoryId);
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
    const existing = await this.getPersistedByUserId(userId);
    const base: PersistedUser = existing ? toPersistedUser(existing) : {
      userId,
      createdAt: Date.now(),
      memories: []
    };
    const updated: PersistedUser = {
      ...base,
      memories: memories.map((item) => createUserMemoryEntry(item))
    };
    await this.upsertPersistedUser(updated);
    this.logger.info({ userId, memoryCount: updated.memories.length }, "user_memories_overwritten");
    return toRuntimeUser(updated);
  }

  async setSpecialRole(userId: string, specialRole: SpecialRole | "none"): Promise<User> {
    const existing = await this.getPersistedByUserId(userId);
    const base: PersistedUser = existing ? toPersistedUser(existing) : {
      userId,
      memories: [],
      createdAt: Date.now()
    };
    const updated: PersistedUser = specialRole === "none"
      ? (({ specialRole: _sr, ...rest }) => rest)(base as PersistedUser & { specialRole?: SpecialRole })
      : { ...base, specialRole };
    await this.upsertUserCore(updated);
    this.logger.info({ userId, specialRole }, "user_special_role_changed");
    return toRuntimeUser(updated);
  }

  async listRows(input: { offset?: number; limit?: number } = {}): Promise<{
    rows: PersistedUser[];
    total: number;
    offset: number;
    limit: number;
  }> {
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 100;
    await this.stateDatabase.init();
    const total = (this.stateDatabase.getDb().prepare(`
      SELECT COUNT(*) AS count
      FROM users
    `).get() as { count: number }).count;
    const userRows = this.stateDatabase.getDb().prepare(`
      SELECT
        user_id AS userId,
        preferred_address AS preferredAddress,
        gender,
        residence,
        timezone,
        occupation,
        profile_summary AS profileSummary,
        relationship_note AS relationshipNote,
        special_role AS specialRole,
        created_at_ms AS createdAt
      FROM users
      ORDER BY user_id ASC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as UserRow[];
    return {
      rows: await this.attachMemories(userRows),
      total,
      offset,
      limit
    };
  }

  async getPersistedRow(userId: string): Promise<PersistedUser | null> {
    return this.getPersistedByUserId(userId);
  }

  async createPersistedRow(value: unknown): Promise<PersistedUser> {
    const parsed = persistedUserSchema.parse({
      ...(value && typeof value === "object" ? value : {}),
      memories: (value as { memories?: unknown } | null)?.memories ?? [],
      createdAt: (value as { createdAt?: unknown } | null)?.createdAt ?? Date.now()
    });
    await this.insertPersistedUser(parsed);
    return parsed;
  }

  async patchPersistedRow(userId: string, patch: Record<string, unknown>): Promise<PersistedUser> {
    const current = await this.getPersistedByUserId(userId);
    if (!current) {
      throw new Error(`User ${userId} not found`);
    }
    const nextUserId = typeof patch.userId === "string" ? patch.userId : userId;
    if (nextUserId !== userId) {
      throw new Error("User id cannot be changed");
    }
    const parsed = persistedUserSchema.parse({
      ...current,
      ...patch,
      userId
    });
    if ("memories" in patch) {
      await this.upsertPersistedUser(parsed);
    } else {
      await this.upsertUserCore(parsed);
    }
    return parsed;
  }

  async deletePersistedRow(userId: string): Promise<void> {
    await this.stateDatabase.init();
    this.stateDatabase.getDb().prepare(`
      DELETE FROM users
      WHERE user_id = ?
    `).run(userId);
  }

  private async readRawAll(): Promise<PersistedUser[]> {
    await this.stateDatabase.init();
    const userRows = this.stateDatabase.getDb().prepare(`
      SELECT
        user_id AS userId,
        preferred_address AS preferredAddress,
        gender,
        residence,
        timezone,
        occupation,
        profile_summary AS profileSummary,
        relationship_note AS relationshipNote,
        special_role AS specialRole,
        created_at_ms AS createdAt
      FROM users
      ORDER BY user_id ASC
    `).all() as UserRow[];
    return this.attachMemories(userRows);
  }

  private async attachMemories(userRows: UserRow[]): Promise<PersistedUser[]> {
    if (userRows.length === 0) {
      return [];
    }
    const memoryRows: UserMemoryRow[] = [];
    const userIds = userRows.map((row) => row.userId);
    for (let index = 0; index < userIds.length; index += 500) {
      const chunk = userIds.slice(index, index + 500);
      const placeholders = chunk.map(() => "?").join(", ");
      memoryRows.push(...this.stateDatabase.getDb().prepare(`
        SELECT
          user_id AS userId,
          id,
          title,
          content,
          kind,
          source,
          importance,
          created_at_ms AS createdAt,
          updated_at_ms AS updatedAt,
          last_used_at_ms AS lastUsedAt
        FROM user_memories
        WHERE user_id IN (${placeholders})
        ORDER BY user_id ASC, created_at_ms ASC, id ASC
      `).all(...chunk) as UserMemoryRow[]);
    }
    const memoriesByUserId = new Map<string, UserMemoryEntry[]>();
    for (const row of memoryRows) {
      const memories = memoriesByUserId.get(row.userId) ?? [];
      memories.push(toMemoryEntry(row));
      memoriesByUserId.set(row.userId, memories);
    }
    return userStoreSchema.parse(userRows.map((row) => ({
      ...toPersistedUserFromRow(row),
      memories: memoriesByUserId.get(row.userId) ?? []
    })));
  }

  private async readAll(): Promise<User[]> {
    return (await this.readRawAll()).map((user) => toRuntimeUser(user));
  }

  private async getPersistedByUserId(userId: string): Promise<PersistedUser | null> {
    await this.stateDatabase.init();
    const row = this.stateDatabase.getDb().prepare(`
      SELECT
        user_id AS userId,
        preferred_address AS preferredAddress,
        gender,
        residence,
        timezone,
        occupation,
        profile_summary AS profileSummary,
        relationship_note AS relationshipNote,
        special_role AS specialRole,
        created_at_ms AS createdAt
      FROM users
      WHERE user_id = ?
    `).get(userId) as UserRow | undefined;
    if (!row) {
      return null;
    }
    const memories = this.stateDatabase.getDb().prepare(`
      SELECT
        user_id AS userId,
        id,
        title,
        content,
        kind,
        source,
        importance,
        created_at_ms AS createdAt,
        updated_at_ms AS updatedAt,
        last_used_at_ms AS lastUsedAt
      FROM user_memories
      WHERE user_id = ?
      ORDER BY created_at_ms ASC, id ASC
    `).all(userId) as UserMemoryRow[];
    return persistedUserSchema.parse({
      ...toPersistedUserFromRow(row),
      memories: memories.map(toMemoryEntry)
    });
  }

  private async upsertUserCore(user: PersistedUser): Promise<void> {
    const validated = persistedUserSchema.parse(user);
    await this.stateDatabase.init();
    putUserCore(this.stateDatabase.getDb(), validated);
  }

  private async upsertMemoryRow(userId: string, memory: UserMemoryEntry): Promise<void> {
    await this.stateDatabase.init();
    this.stateDatabase.getDb().transaction(() => {
      const user = this.stateDatabase.getDb().prepare(`
        SELECT
          user_id AS userId,
          preferred_address AS preferredAddress,
          gender,
          residence,
          timezone,
          occupation,
          profile_summary AS profileSummary,
          relationship_note AS relationshipNote,
          special_role AS specialRole,
          created_at_ms AS createdAt
        FROM users
        WHERE user_id = ?
      `).get(userId) as UserRow | undefined;
      putUserCore(this.stateDatabase.getDb(), user
        ? { ...toPersistedUserFromRow(user), memories: [] }
        : { userId, memories: [], createdAt: Date.now() });
      upsertMemory(this.stateDatabase.getDb(), userId, memory);
    })();
  }

  private async deleteMemoryRow(userId: string, memoryId: string): Promise<void> {
    await this.stateDatabase.init();
    this.stateDatabase.getDb().prepare(`
      DELETE FROM user_memories
      WHERE user_id = ? AND id = ?
    `).run(userId, memoryId);
  }

  private async insertPersistedUser(user: PersistedUser): Promise<void> {
    const validated = persistedUserSchema.parse(user);
    await this.stateDatabase.init();
    try {
      this.stateDatabase.getDb().transaction((next: PersistedUser) => {
        insertUserCore(this.stateDatabase.getDb(), next);
        for (const memory of next.memories) {
          insertMemory(this.stateDatabase.getDb(), next.userId, memory);
        }
      })(validated);
    } catch (error: unknown) {
      if (isSqliteConstraintError(error)) {
        throw new Error(`User ${validated.userId} already exists`);
      }
      throw error;
    }
  }

  private async upsertPersistedUser(user: PersistedUser): Promise<void> {
    const validated = persistedUserSchema.parse(user);
    await this.stateDatabase.init();
    this.stateDatabase.getDb().transaction((next: PersistedUser) => {
      putUserCore(this.stateDatabase.getDb(), next);
      this.stateDatabase.getDb().prepare(`
        DELETE FROM user_memories
        WHERE user_id = ?
      `).run(next.userId);
      for (const memory of next.memories) {
        insertMemory(this.stateDatabase.getDb(), next.userId, memory);
      }
    })(validated);
  }
}

type UserRow = {
  userId: string;
  preferredAddress: string | null;
  gender: string | null;
  residence: string | null;
  timezone: string | null;
  occupation: string | null;
  profileSummary: string | null;
  relationshipNote: string | null;
  specialRole: SpecialRole | null;
  createdAt: number;
};

type UserMemoryRow = {
  userId: string;
  id: string;
  title: string;
  content: string;
  kind: UserMemoryEntry["kind"];
  source: UserMemoryEntry["source"];
  importance: number | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
};

function toPersistedUserFromRow(row: UserRow): Omit<PersistedUser, "memories"> {
  return {
    userId: row.userId,
    ...(row.preferredAddress != null ? { preferredAddress: row.preferredAddress } : {}),
    ...(row.gender != null ? { gender: row.gender } : {}),
    ...(row.residence != null ? { residence: row.residence } : {}),
    ...(row.timezone != null ? { timezone: row.timezone } : {}),
    ...(row.occupation != null ? { occupation: row.occupation } : {}),
    ...(row.profileSummary != null ? { profileSummary: row.profileSummary } : {}),
    ...(row.relationshipNote != null ? { relationshipNote: row.relationshipNote } : {}),
    ...(row.specialRole != null ? { specialRole: row.specialRole } : {}),
    createdAt: row.createdAt
  };
}

function toMemoryEntry(row: UserMemoryRow): UserMemoryEntry {
  return createUserMemoryEntry({
    id: row.id,
    title: row.title,
    content: row.content,
    kind: row.kind,
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.importance != null ? { importance: row.importance } : {}),
    ...(row.lastUsedAt != null ? { lastUsedAt: row.lastUsedAt } : {})
  });
}

function toUserParams(user: PersistedUser): Record<string, unknown> {
  return {
    userId: user.userId,
    preferredAddress: user.preferredAddress ?? null,
    gender: user.gender ?? null,
    residence: user.residence ?? null,
    timezone: user.timezone ?? null,
    occupation: user.occupation ?? null,
    profileSummary: user.profileSummary ?? null,
    relationshipNote: user.relationshipNote ?? null,
    specialRole: user.specialRole ?? null,
    createdAt: user.createdAt
  };
}

function putUserCore(db: SqliteDatabase, user: PersistedUser): void {
  db.prepare(`
    INSERT INTO users (
      user_id,
      preferred_address,
      gender,
      residence,
      timezone,
      occupation,
      profile_summary,
      relationship_note,
      special_role,
      created_at_ms
    )
    VALUES (
      @userId,
      @preferredAddress,
      @gender,
      @residence,
      @timezone,
      @occupation,
      @profileSummary,
      @relationshipNote,
      @specialRole,
      @createdAt
    )
    ON CONFLICT(user_id) DO UPDATE SET
      preferred_address = excluded.preferred_address,
      gender = excluded.gender,
      residence = excluded.residence,
      timezone = excluded.timezone,
      occupation = excluded.occupation,
      profile_summary = excluded.profile_summary,
      relationship_note = excluded.relationship_note,
      special_role = excluded.special_role,
      created_at_ms = excluded.created_at_ms
  `).run(toUserParams(user));
}

function insertUserCore(db: SqliteDatabase, user: PersistedUser): void {
  db.prepare(`
    INSERT INTO users (
      user_id,
      preferred_address,
      gender,
      residence,
      timezone,
      occupation,
      profile_summary,
      relationship_note,
      special_role,
      created_at_ms
    )
    VALUES (
      @userId,
      @preferredAddress,
      @gender,
      @residence,
      @timezone,
      @occupation,
      @profileSummary,
      @relationshipNote,
      @specialRole,
      @createdAt
    )
  `).run(toUserParams(user));
}

function isSqliteConstraintError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && String((error as { code?: unknown }).code).startsWith("SQLITE_CONSTRAINT");
}

function insertMemory(db: SqliteDatabase, userId: string, memory: UserMemoryEntry): void {
  db.prepare(`
    INSERT INTO user_memories (
      user_id,
      id,
      title,
      content,
      kind,
      source,
      importance,
      created_at_ms,
      updated_at_ms,
      last_used_at_ms
    )
    VALUES (
      @userId,
      @id,
      @title,
      @content,
      @kind,
      @source,
      @importance,
      @createdAt,
      @updatedAt,
      @lastUsedAt
    )
  `).run(toMemoryParams(userId, memory));
}

function upsertMemory(db: SqliteDatabase, userId: string, memory: UserMemoryEntry): void {
  db.prepare(`
    INSERT INTO user_memories (
      user_id,
      id,
      title,
      content,
      kind,
      source,
      importance,
      created_at_ms,
      updated_at_ms,
      last_used_at_ms
    )
    VALUES (
      @userId,
      @id,
      @title,
      @content,
      @kind,
      @source,
      @importance,
      @createdAt,
      @updatedAt,
      @lastUsedAt
    )
    ON CONFLICT(user_id, id) DO UPDATE SET
      title = excluded.title,
      content = excluded.content,
      kind = excluded.kind,
      source = excluded.source,
      importance = excluded.importance,
      created_at_ms = excluded.created_at_ms,
      updated_at_ms = excluded.updated_at_ms,
      last_used_at_ms = excluded.last_used_at_ms
  `).run(toMemoryParams(userId, memory));
}

function toMemoryParams(userId: string, memory: UserMemoryEntry): Record<string, unknown> {
  return {
    userId,
    id: memory.id,
    title: memory.title,
    content: memory.content,
    kind: memory.kind,
    source: memory.source,
    importance: memory.importance ?? null,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    lastUsedAt: memory.lastUsedAt ?? null
  };
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
