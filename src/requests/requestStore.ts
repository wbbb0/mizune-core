import type { Logger } from "pino";
import type { OneBotRequestEvent } from "#services/onebot/types.ts";
import { StateDatabase } from "#data/state/stateDatabase.ts";
import {
  pendingRequestSchema,
  type PendingFriendRequest,
  type PendingGroupRequest,
  type PendingRequest
} from "./requestSchema.ts";

export class RequestStore {
  constructor(
    dataDir: string,
    private readonly logger: Logger,
    private readonly stateDatabase = new StateDatabase(dataDir, logger)
  ) {
  }

  async init(): Promise<void> {
    await this.stateDatabase.init();
  }

  async listFriendRequests(): Promise<PendingFriendRequest[]> {
    const requests = await this.readAll();
    return requests.filter((item): item is PendingFriendRequest => item.kind === "friend");
  }

  async listGroupRequests(): Promise<PendingGroupRequest[]> {
    const requests = await this.readAll();
    return requests.filter((item): item is PendingGroupRequest => item.kind === "group");
  }

  async upsertFromEvent(event: OneBotRequestEvent): Promise<void> {
    let request: PendingRequest;
    if (event.request_type === "friend") {
      request = {
        kind: "friend",
        flag: event.flag,
        userId: String(event.user_id),
        comment: String(event.comment ?? ""),
        createdAt: Date.now()
      };
    } else {
      request = {
        kind: "group",
        flag: event.flag,
        userId: String(event.user_id),
        groupId: String(event.group_id),
        subType: event.sub_type,
        comment: String(event.comment ?? ""),
        createdAt: Date.now()
      };
    }

    await this.upsertRequest(request);
    this.logger.info({ kind: event.request_type, flag: event.flag }, "request_cached");
  }

  async remove(flag: string): Promise<void> {
    await this.stateDatabase.init();
    this.stateDatabase.getDb().prepare(`
      DELETE FROM pending_requests
      WHERE flag = ?
    `).run(flag);
  }

  async get(flag: string): Promise<PendingRequest | null> {
    await this.stateDatabase.init();
    const row = this.stateDatabase.getDb().prepare(`
      SELECT
        flag,
        kind,
        user_id AS userId,
        group_id AS groupId,
        sub_type AS subType,
        comment,
        created_at_ms AS createdAt
      FROM pending_requests
      WHERE flag = ?
    `).get(flag) as PendingRequestRow | undefined;
    return row ? toPendingRequest(row) : null;
  }

  async listRows(input: { offset?: number; limit?: number } = {}): Promise<{
    rows: PendingRequest[];
    total: number;
    offset: number;
    limit: number;
  }> {
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 100;
    await this.stateDatabase.init();
    const total = (this.stateDatabase.getDb().prepare(`
      SELECT COUNT(*) AS count
      FROM pending_requests
    `).get() as { count: number }).count;
    const rows = this.stateDatabase.getDb().prepare(`
      SELECT
        flag,
        kind,
        user_id AS userId,
        group_id AS groupId,
        sub_type AS subType,
        comment,
        created_at_ms AS createdAt
      FROM pending_requests
      ORDER BY sort_order ASC, flag ASC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as PendingRequestRow[];
    return {
      rows: rows.map(toPendingRequest),
      total,
      offset,
      limit
    };
  }

  private async readAll(): Promise<PendingRequest[]> {
    await this.stateDatabase.init();
    const rows = this.stateDatabase.getDb().prepare(`
      SELECT
        flag,
        kind,
        user_id AS userId,
        group_id AS groupId,
        sub_type AS subType,
        comment,
        created_at_ms AS createdAt
      FROM pending_requests
      ORDER BY sort_order ASC, flag ASC
    `).all() as PendingRequestRow[];
    return rows.map(toPendingRequest);
  }

  async createRow(value: unknown): Promise<PendingRequest> {
    const parsed = pendingRequestSchema.parse(value);
    await this.insertRequest(parsed);
    return parsed;
  }

  async patchRow(flag: string, patch: Record<string, unknown>): Promise<PendingRequest> {
    await this.stateDatabase.init();
    return this.stateDatabase.getDb().transaction(() => {
      const current = this.selectRequest(flag);
      if (!current) {
        throw new Error(`Request ${flag} not found`);
      }
      const nextFlag = typeof patch.flag === "string" ? patch.flag : flag;
      if (nextFlag !== flag) {
        throw new Error("Request flag cannot be changed");
      }
      const parsed = pendingRequestSchema.parse({
        ...current,
        ...patch,
        flag
      });
      this.updateRequest(parsed);
      return parsed;
    })();
  }

  async deleteRow(flag: string): Promise<void> {
    await this.remove(flag);
  }

  private async insertRequest(request: PendingRequest): Promise<void> {
    await this.stateDatabase.init();
    try {
      this.stateDatabase.getDb().transaction((next: PendingRequest) => {
        insertRequestRow(this.stateDatabase.getDb(), next, nextRequestSortOrder(this.stateDatabase.getDb()));
      })(request);
    } catch (error: unknown) {
      if (isSqliteConstraintError(error)) {
        throw new Error(`Request ${request.flag} already exists`);
      }
      throw error;
    }
  }

  private selectRequest(flag: string): PendingRequest | null {
    const row = this.stateDatabase.getDb().prepare(`
      SELECT
        flag,
        kind,
        user_id AS userId,
        group_id AS groupId,
        sub_type AS subType,
        comment,
        created_at_ms AS createdAt
      FROM pending_requests
      WHERE flag = ?
    `).get(flag) as PendingRequestRow | undefined;
    return row ? toPendingRequest(row) : null;
  }

  private updateRequest(request: PendingRequest): void {
    const result = this.stateDatabase.getDb().prepare(`
      UPDATE pending_requests
      SET
        kind = @kind,
        user_id = @userId,
        group_id = @groupId,
        sub_type = @subType,
        comment = @comment,
        created_at_ms = @createdAt
      WHERE flag = @flag
    `).run(toRequestParams(request));
    if (result.changes === 0) {
      throw new Error(`Request ${request.flag} not found`);
    }
  }

  private async upsertRequest(request: PendingRequest): Promise<void> {
    await this.stateDatabase.init();
    this.stateDatabase.getDb().transaction((next: PendingRequest) => {
      upsertRequestRow(this.stateDatabase.getDb(), next, nextRequestSortOrder(this.stateDatabase.getDb()));
    })(request);
  }
}

type PendingRequestRow = {
  flag: string;
  kind: "friend" | "group";
  userId: string;
  groupId: string | null;
  subType: "add" | "invite" | null;
  comment: string;
  createdAt: number;
};

function toPendingRequest(row: PendingRequestRow): PendingRequest {
  return pendingRequestSchema.parse({
    kind: row.kind,
    flag: row.flag,
    userId: row.userId,
    ...(row.kind === "group" ? {
      groupId: row.groupId,
      subType: row.subType
    } : {}),
    comment: row.comment,
    createdAt: row.createdAt
  });
}

function toRequestParams(request: PendingRequest): Record<string, unknown> {
  return {
    flag: request.flag,
    kind: request.kind,
    userId: request.userId,
    groupId: request.kind === "group" ? request.groupId : null,
    subType: request.kind === "group" ? request.subType : null,
    comment: request.comment,
    createdAt: request.createdAt
  };
}

function nextRequestSortOrder(db: ReturnType<StateDatabase["getDb"]>): number {
  const row = db.prepare(`
    SELECT COALESCE(MAX(sort_order), 0) + 1 AS nextSortOrder
    FROM pending_requests
  `).get() as { nextSortOrder: number };
  return row.nextSortOrder;
}

function insertRequestRow(
  db: ReturnType<StateDatabase["getDb"]>,
  request: PendingRequest,
  sortOrder: number
): void {
  db.prepare(`
    INSERT INTO pending_requests (
      flag,
      kind,
      user_id,
      group_id,
      sub_type,
      comment,
      created_at_ms,
      sort_order
    )
    VALUES (
      @flag,
      @kind,
      @userId,
      @groupId,
      @subType,
      @comment,
      @createdAt,
      @sortOrder
    )
  `).run({
    ...toRequestParams(request),
    sortOrder
  });
}

function upsertRequestRow(
  db: ReturnType<StateDatabase["getDb"]>,
  request: PendingRequest,
  sortOrder: number
): void {
  db.prepare(`
    INSERT INTO pending_requests (
      flag,
      kind,
      user_id,
      group_id,
      sub_type,
      comment,
      created_at_ms,
      sort_order
    )
    VALUES (
      @flag,
      @kind,
      @userId,
      @groupId,
      @subType,
      @comment,
      @createdAt,
      @sortOrder
    )
    ON CONFLICT(flag) DO UPDATE SET
      kind = excluded.kind,
      user_id = excluded.user_id,
      group_id = excluded.group_id,
      sub_type = excluded.sub_type,
      comment = excluded.comment,
      created_at_ms = excluded.created_at_ms,
      sort_order = excluded.sort_order
  `).run({
    ...toRequestParams(request),
    sortOrder
  });
}

function isSqliteConstraintError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && String((error as { code?: unknown }).code).startsWith("SQLITE_CONSTRAINT");
}
