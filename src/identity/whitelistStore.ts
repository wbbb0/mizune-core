import type { Logger } from "pino";
import { StateDatabase } from "#data/state/stateDatabase.ts";

export interface WhitelistSnapshot {
  users: string[];
  groups: string[];
}

export interface WhitelistEntryRow {
  targetType: "user" | "group";
  targetId: string;
  createdAtMs: number;
}

export class WhitelistStore {
  private current: WhitelistSnapshot = emptyWhitelist();

  constructor(
    dataDir: string,
    private readonly logger: Logger,
    private readonly stateDatabase = new StateDatabase(dataDir, logger)
  ) {
  }

  async init(): Promise<void> {
    await this.stateDatabase.init();
    await this.reloadFromDisk();
  }

  getSnapshot(): WhitelistSnapshot {
    return cloneSnapshot(this.current);
  }

  hasUser(userId: string): boolean {
    return this.current.users.includes(userId);
  }

  hasGroup(groupId: string): boolean {
    return this.current.groups.includes(groupId);
  }

  async addUser(userId: string): Promise<string[]> {
    await this.upsertEntry("user", userId);
    const next = this.getSnapshot();
    this.logger.info({ userCount: next.users.length, groupCount: next.groups.length }, "whitelist_persisted");
    return [...next.users];
  }

  async removeUser(userId: string): Promise<string[]> {
    await this.deleteEntry("user", userId);
    const next = this.getSnapshot();
    this.logger.info({ userCount: next.users.length, groupCount: next.groups.length }, "whitelist_persisted");
    return [...next.users];
  }

  async addGroup(groupId: string): Promise<string[]> {
    await this.upsertEntry("group", groupId);
    const next = this.getSnapshot();
    this.logger.info({ userCount: next.users.length, groupCount: next.groups.length }, "whitelist_persisted");
    return [...next.groups];
  }

  async removeGroup(groupId: string): Promise<string[]> {
    await this.deleteEntry("group", groupId);
    const next = this.getSnapshot();
    this.logger.info({ userCount: next.users.length, groupCount: next.groups.length }, "whitelist_persisted");
    return [...next.groups];
  }

  async ensureUser(userId: string): Promise<string[]> {
    return this.addUser(userId);
  }

  async reloadFromDisk(): Promise<WhitelistSnapshot> {
    const next = await this.readAll();
    this.current = next;
    return cloneSnapshot(next);
  }

  private async readAll(): Promise<WhitelistSnapshot> {
    const rows = await this.listEntries();
    return normalizeSnapshot({
      users: rows.filter((row) => row.targetType === "user").map((row) => row.targetId),
      groups: rows.filter((row) => row.targetType === "group").map((row) => row.targetId)
    });
  }

  async listEntries(): Promise<WhitelistEntryRow[]> {
    const rows = this.stateDatabase.getDb().prepare(`
      SELECT
        target_type AS targetType,
        target_id AS targetId,
        created_at_ms AS createdAtMs
      FROM whitelist_entries
      ORDER BY target_type ASC, target_id ASC
    `).all() as WhitelistEntryRow[];
    return rows.map((row) => ({
      targetType: row.targetType,
      targetId: row.targetId,
      createdAtMs: row.createdAtMs
    }));
  }

  async upsertEntry(targetType: "user" | "group", targetId: string): Promise<WhitelistEntryRow> {
    const normalizedTargetId = targetId.trim();
    if (!normalizedTargetId) {
      throw new Error("whitelist target id is required");
    }
    const now = Date.now();
    this.stateDatabase.getDb().prepare(`
      INSERT INTO whitelist_entries (target_type, target_id, created_at_ms)
      VALUES (@targetType, @targetId, @createdAtMs)
      ON CONFLICT(target_type, target_id) DO NOTHING
    `).run({
      targetType,
      targetId: normalizedTargetId,
      createdAtMs: now
    });
    this.current = await this.readAll();
    return {
      targetType,
      targetId: normalizedTargetId,
      createdAtMs: now
    };
  }

  async patchEntry(
    currentTargetType: "user" | "group",
    currentTargetId: string,
    next: WhitelistEntryRow
  ): Promise<WhitelistEntryRow> {
    const normalizedCurrentTargetId = currentTargetId.trim();
    const normalizedNextTargetId = next.targetId.trim();
    if (!normalizedCurrentTargetId || !normalizedNextTargetId) {
      throw new Error("whitelist target id is required");
    }
    const db = this.stateDatabase.getDb();
    const update = db.transaction(() => {
      const deleted = db.prepare(`
        DELETE FROM whitelist_entries
        WHERE target_type = ?
          AND target_id = ?
      `).run(currentTargetType, normalizedCurrentTargetId);
      if (deleted.changes === 0) {
        throw new Error(`whitelist entry not found: ${currentTargetType}:${normalizedCurrentTargetId}`);
      }
      db.prepare(`
        INSERT INTO whitelist_entries (target_type, target_id, created_at_ms)
        VALUES (@targetType, @targetId, @createdAtMs)
        ON CONFLICT(target_type, target_id) DO UPDATE SET
          created_at_ms = excluded.created_at_ms
      `).run({
        targetType: next.targetType,
        targetId: normalizedNextTargetId,
        createdAtMs: next.createdAtMs
      });
    });
    update();
    this.current = await this.readAll();
    return {
      targetType: next.targetType,
      targetId: normalizedNextTargetId,
      createdAtMs: next.createdAtMs
    };
  }

  async deleteEntry(targetType: "user" | "group", targetId: string): Promise<void> {
    this.stateDatabase.getDb().prepare(`
      DELETE FROM whitelist_entries
      WHERE target_type = ?
        AND target_id = ?
    `).run(targetType, targetId.trim());
    this.current = await this.readAll();
  }
}

function normalizeSnapshot(snapshot: WhitelistSnapshot): WhitelistSnapshot {
  return {
    users: uniqueSorted(snapshot.users.map((item) => item.trim()).filter(Boolean)),
    groups: uniqueSorted(snapshot.groups.map((item) => item.trim()).filter(Boolean))
  };
}

function emptyWhitelist(): WhitelistSnapshot {
  return {
    users: [],
    groups: []
  };
}

function cloneSnapshot(snapshot: WhitelistSnapshot): WhitelistSnapshot {
  return {
    users: [...snapshot.users],
    groups: [...snapshot.groups]
  };
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}
