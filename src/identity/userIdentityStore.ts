import { randomBytes } from "node:crypto";
import type { Logger } from "pino";
import { StateDatabase } from "#data/state/stateDatabase.ts";
import {
  userIdentityRecordSchema,
  userIdentityStoreSchema,
  type UserIdentityRecord,
  type UserIdentityScope
} from "./userIdentitySchema.ts";

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export class UserIdentityStore {
  private current: UserIdentityRecord[] = [];

  constructor(
    dataDir: string,
    private readonly logger: Logger,
    private readonly stateDatabase = new StateDatabase(dataDir, logger)
  ) {
  }

  async init(): Promise<void> {
    await this.stateDatabase.init();
    this.current = await this.readAllFromDb();
  }

  async list(): Promise<UserIdentityRecord[]> {
    return [...await this.readAll()];
  }

  async listRows(input: { offset?: number; limit?: number } = {}): Promise<{
    rows: UserIdentityRecord[];
    total: number;
    offset: number;
    limit: number;
  }> {
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 100;
    const rows = await this.readAll();
    return {
      rows: rows.slice(offset, offset + limit),
      total: rows.length,
      offset,
      limit
    };
  }

  async getRow(identity: Pick<UserIdentityRecord, "channelId" | "scope" | "externalId">): Promise<UserIdentityRecord | null> {
    return (await this.readAll()).find((record) => matchesExternal(record, identity)) ?? null;
  }

  async createRow(value: unknown): Promise<UserIdentityRecord> {
    const parsed = userIdentityRecordSchema.parse(value);
    await this.assertIdentityCanBeInserted(parsed);
    const row = normalizeRecord(parsed);
    await this.insertIdentity(row);
    this.current = await this.readAllFromDb();
    return row;
  }

  async patchRow(
    identity: Pick<UserIdentityRecord, "channelId" | "scope" | "externalId">,
    patch: Record<string, unknown>
  ): Promise<UserIdentityRecord> {
    const current = await this.getRow(identity);
    if (!current) {
      throw new Error("User identity not found");
    }
    const parsed = userIdentityRecordSchema.parse({ ...current, ...patch });
    if (!matchesExternal(parsed, identity)) {
      throw new Error("User identity row id cannot be changed");
    }
    await this.stateDatabase.init();
    this.stateDatabase.getDb().prepare(`
      UPDATE user_identities
      SET
        internal_user_id = @internalUserId,
        created_at_ms = @createdAt
      WHERE channel_id = @channelId
        AND scope = @scope
        AND external_id = @externalId
    `).run(parsed);
    this.current = await this.readAllFromDb();
    return parsed;
  }

  async deleteRow(identity: Pick<UserIdentityRecord, "channelId" | "scope" | "externalId">): Promise<void> {
    await this.stateDatabase.init();
    this.stateDatabase.getDb().prepare(`
      DELETE FROM user_identities
      WHERE channel_id = @channelId
        AND scope = @scope
        AND external_id = @externalId
    `).run(identity);
    this.current = await this.readAllFromDb();
  }

  async findInternalUserId(input: {
    channelId: string;
    externalId: string;
    scope?: UserIdentityScope;
  }): Promise<string | undefined> {
    return (await this.findRecord(input))?.internalUserId;
  }

  async hasOwnerIdentity(): Promise<boolean> {
    return (await this.findIdentityByInternalUserId("owner")) != null;
  }

  hasOwnerIdentitySync(): boolean {
    return this.current.some((record) => record.internalUserId === "owner");
  }

  async findIdentityByInternalUserId(
    internalUserId: string
  ): Promise<UserIdentityRecord | undefined> {
    return (await this.readAll()).find((record) => record.internalUserId === internalUserId);
  }

  findIdentityByInternalUserIdSync(
    internalUserId: string
  ): UserIdentityRecord | undefined {
    return this.current.find((record) => record.internalUserId === internalUserId);
  }

  findInternalUserIdSync(input: {
    channelId: string;
    externalId: string;
    scope?: UserIdentityScope;
  }): string | undefined {
    return this.current.find((record) => matchesExternal(record, normalizeExternalRef(input)))?.internalUserId;
  }

  async bindOwnerIdentity(input: {
    channelId: string;
    externalId: string;
  }): Promise<UserIdentityRecord> {
    return this.bindIdentity({
      channelId: input.channelId,
      externalId: input.externalId,
      internalUserId: "owner",
      scope: "private_user"
    });
  }

  async ensureUserIdentity(input: {
    channelId: string;
    externalId: string;
    scope?: UserIdentityScope;
  }): Promise<UserIdentityRecord> {
    const existing = await this.findRecord(input);
    if (existing) {
      return existing;
    }
    return this.bindIdentity({
      channelId: input.channelId,
      externalId: input.externalId,
      internalUserId: createOpaqueInternalUserId(),
      scope: input.scope ?? "private_user"
    });
  }

  async bindIdentity(input: {
    channelId: string;
    externalId: string;
    internalUserId: string;
    scope?: UserIdentityScope;
  }): Promise<UserIdentityRecord> {
    const scope = input.scope ?? "private_user";
    const next = normalizeRecord({
      channelId: input.channelId,
      scope,
      externalId: input.externalId,
      internalUserId: input.internalUserId,
      createdAt: Date.now()
    });
    const records = await this.readAll();
    const sameExternal = records.find((record) => matchesExternal(record, next));
    if (sameExternal) {
      if (sameExternal.internalUserId === next.internalUserId) {
        return sameExternal;
      }
      throw new Error(`External identity ${next.channelId}:${next.externalId} is already bound`);
    }
    const sameInternal = records.find((record) => record.internalUserId === next.internalUserId);
    if (sameInternal) {
      throw new Error(`Internal user ${next.internalUserId} already has an external identity`);
    }
    await this.insertIdentity(next);
    this.current = await this.readAllFromDb();
    this.logger.info({
      channelId: next.channelId,
      scope: next.scope,
      externalId: next.externalId,
      internalUserId: next.internalUserId
    }, "user_identity_bound");
    return next;
  }

  private async findRecord(input: {
    channelId: string;
    externalId: string;
    scope?: UserIdentityScope;
  }): Promise<UserIdentityRecord | undefined> {
    const normalized = normalizeExternalRef(input);
    return (await this.readAll()).find((record) => matchesExternal(record, normalized));
  }

  private async assertIdentityCanBeInserted(next: UserIdentityRecord): Promise<void> {
    const records = await this.readAll();
    const sameExternal = records.find((record) => matchesExternal(record, next));
    if (sameExternal) {
      throw new Error(`External identity ${next.channelId}:${next.externalId} is already bound`);
    }
    const sameInternal = records.find((record) => record.internalUserId === next.internalUserId);
    if (sameInternal) {
      throw new Error(`Internal user ${next.internalUserId} already has an external identity`);
    }
  }

  private async insertIdentity(record: UserIdentityRecord): Promise<void> {
    await this.stateDatabase.init();
    this.stateDatabase.getDb().prepare(`
      INSERT INTO user_identities (
        channel_id,
        scope,
        external_id,
        internal_user_id,
        created_at_ms
      )
      VALUES (
        @channelId,
        @scope,
        @externalId,
        @internalUserId,
        @createdAt
      )
    `).run(record);
  }

  private async readAll(): Promise<UserIdentityRecord[]> {
    this.current = await this.readAllFromDb();
    return [...this.current];
  }

  private async readAllFromDb(): Promise<UserIdentityRecord[]> {
    await this.stateDatabase.init();
    const rows = this.stateDatabase.getDb().prepare(`
      SELECT
        channel_id AS channelId,
        scope,
        external_id AS externalId,
        internal_user_id AS internalUserId,
        created_at_ms AS createdAt
      FROM user_identities
      ORDER BY channel_id ASC, scope ASC, external_id ASC
    `).all() as UserIdentityRecord[];
    return sortRecords(userIdentityStoreSchema.parse(rows));
  }
}

function createOpaqueInternalUserId(): string {
  return `u_${createUlid()}`;
}

function createUlid(now = Date.now()): string {
  const timestamp = encodeCrockford(BigInt(now), 10);
  const random = encodeCrockford(bytesToBigInt(randomBytes(10)), 16);
  return `${timestamp}${random}`;
}

function encodeCrockford(value: bigint, length: number): string {
  let current = value;
  let encoded = "";
  for (let index = 0; index < length; index += 1) {
    const remainder = Number(current % 32n);
    encoded = `${CROCKFORD_BASE32[remainder]}${encoded}`;
    current /= 32n;
  }
  return encoded;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) + BigInt(byte);
  }
  return value;
}

function normalizeRecord(input: UserIdentityRecord): UserIdentityRecord {
  return {
    channelId: input.channelId.trim(),
    scope: input.scope,
    externalId: input.externalId.trim(),
    internalUserId: input.internalUserId.trim(),
    createdAt: input.createdAt
  };
}

function normalizeExternalRef(input: {
  channelId: string;
  externalId: string;
  scope?: UserIdentityScope;
}) {
  return {
    channelId: input.channelId.trim(),
    scope: input.scope ?? "private_user",
    externalId: input.externalId.trim()
  };
}

function matchesExternal(
  record: Pick<UserIdentityRecord, "channelId" | "scope" | "externalId">,
  candidate: Pick<UserIdentityRecord, "channelId" | "scope" | "externalId"> | ReturnType<typeof normalizeExternalRef>
): boolean {
  return record.channelId === candidate.channelId
    && record.scope === candidate.scope
    && record.externalId === candidate.externalId;
}

function sortRecords(records: UserIdentityRecord[]): UserIdentityRecord[] {
  return [...records].sort((left, right) => (
    left.channelId.localeCompare(right.channelId)
    || left.scope.localeCompare(right.scope)
    || left.externalId.localeCompare(right.externalId)
  ));
}
