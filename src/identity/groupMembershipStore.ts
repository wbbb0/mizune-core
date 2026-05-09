import type { Logger } from "pino";
import { StateDatabase } from "#data/state/stateDatabase.ts";

const POSITIVE_TTL_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 60 * 1000;

export class GroupMembershipStore {
  constructor(
    dataDir: string,
    logger: Logger,
    private readonly stateDatabase = new StateDatabase(dataDir, logger)
  ) {
  }

  async init(): Promise<void> {
    await this.stateDatabase.init();
  }

  async listRows(input: { offset?: number; limit?: number } = {}): Promise<{
    rows: GroupMembershipRow[];
    total: number;
    offset: number;
    limit: number;
  }> {
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 100;
    await this.stateDatabase.init();
    const total = (this.stateDatabase.getDb().prepare(`
      SELECT COUNT(*) AS count
      FROM group_membership_entries
    `).get() as { count: number }).count;
    const rows = this.stateDatabase.getDb().prepare(`
      SELECT
        group_id AS groupId,
        user_id AS userId,
        is_member AS isMember,
        verified_at_ms AS verifiedAt
      FROM group_membership_entries
      ORDER BY group_id ASC, user_id ASC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as Array<{
      groupId: string;
      userId: string;
      isMember: 0 | 1;
      verifiedAt: number;
    }>;
    return {
      rows: rows.map((row) => ({
        groupId: row.groupId,
        userId: row.userId,
        isMember: row.isMember === 1,
        verifiedAt: row.verifiedAt
      })),
      total,
      offset,
      limit
    };
  }

  async get(groupId: string, userId: string, now = Date.now()): Promise<boolean | null> {
    const entry = await this.getRow(groupId, userId);
    if (!entry) {
      return null;
    }
    const ttlMs = entry.isMember ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
    if (now - entry.verifiedAt > ttlMs) {
      return null;
    }
    return entry.isMember;
  }

  async getRow(groupId: string, userId: string): Promise<GroupMembershipRow | null> {
    await this.stateDatabase.init();
    const entry = this.stateDatabase.getDb().prepare(`
      SELECT
        group_id AS groupId,
        user_id AS userId,
        is_member AS isMember,
        verified_at_ms AS verifiedAt
      FROM group_membership_entries
      WHERE group_id = ? AND user_id = ?
    `).get(groupId.trim(), userId.trim()) as {
      groupId: string;
      userId: string;
      isMember: 0 | 1;
      verifiedAt: number;
    } | undefined;
    if (!entry) {
      return null;
    }
    return {
      groupId: entry.groupId,
      userId: entry.userId,
      isMember: entry.isMember === 1,
      verifiedAt: entry.verifiedAt
    };
  }

  async createRow(row: GroupMembershipRow): Promise<GroupMembershipRow> {
    if (await this.getRow(row.groupId, row.userId)) {
      throw new Error(`Group membership ${row.groupId}:${row.userId} already exists`);
    }
    await this.insertRow(row);
    return row;
  }

  async patchRow(
    groupId: string,
    userId: string,
    patch: Partial<Omit<GroupMembershipRow, "groupId" | "userId">>
  ): Promise<GroupMembershipRow> {
    const current = await this.getRow(groupId, userId);
    if (!current) {
      throw new Error(`Group membership ${groupId}:${userId} not found`);
    }
    const next: GroupMembershipRow = {
      ...current,
      ...patch,
      groupId: current.groupId,
      userId: current.userId
    };
    await this.remember(next.groupId, next.userId, next.isMember, next.verifiedAt);
    return next;
  }

  async remember(groupId: string, userId: string, isMember: boolean, verifiedAt = Date.now()): Promise<void> {
    await this.stateDatabase.init();
    this.stateDatabase.getDb().prepare(`
      INSERT INTO group_membership_entries (
        group_id,
        user_id,
        is_member,
        verified_at_ms
      )
      VALUES (?, ?, ?, ?)
      ON CONFLICT(group_id, user_id) DO UPDATE SET
        is_member = excluded.is_member,
        verified_at_ms = excluded.verified_at_ms
    `).run(groupId.trim(), userId.trim(), isMember ? 1 : 0, verifiedAt);
  }

  async rememberSeen(groupId: string, userId: string, seenAt = Date.now()): Promise<void> {
    await this.remember(groupId, userId, true, seenAt);
  }

  async deleteRow(groupId: string, userId: string): Promise<void> {
    await this.stateDatabase.init();
    this.stateDatabase.getDb().prepare(`
      DELETE FROM group_membership_entries
      WHERE group_id = ? AND user_id = ?
    `).run(groupId.trim(), userId.trim());
  }

  private async insertRow(row: GroupMembershipRow): Promise<void> {
    await this.stateDatabase.init();
    this.stateDatabase.getDb().prepare(`
      INSERT INTO group_membership_entries (
        group_id,
        user_id,
        is_member,
        verified_at_ms
      )
      VALUES (?, ?, ?, ?)
    `).run(row.groupId.trim(), row.userId.trim(), row.isMember ? 1 : 0, row.verifiedAt);
  }
}

export type GroupMembershipRow = {
  groupId: string;
  userId: string;
  isMember: boolean;
  verifiedAt: number;
};
