import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Logger } from "pino";
import { FileSchemaStore } from "#data/fileSchemaStore.ts";
import {
  userIdentityStoreSchema,
  type UserIdentityRecord,
  type UserIdentityScope
} from "./userIdentitySchema.ts";

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export class UserIdentityStore {
  private readonly store: FileSchemaStore<typeof userIdentityStoreSchema>;
  private current: UserIdentityRecord[] = [];

  constructor(
    dataDir: string,
    private readonly logger: Logger
  ) {
    this.store = new FileSchemaStore({
      filePath: join(dataDir, "user-identities.json"),
      schema: userIdentityStoreSchema,
      logger,
      loadErrorEvent: "user_identity_store_load_failed",
      atomicWrite: true
    });
  }

  async init(): Promise<void> {
    this.current = sortRecords(await this.store.readOrDefault([]));
  }

  async list(): Promise<UserIdentityRecord[]> {
    return [...await this.readAll()];
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
    const updated = sortRecords([...records, next]);
    await this.store.write(updated);
    this.current = updated;
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

  private async readAll(): Promise<UserIdentityRecord[]> {
    this.current = sortRecords(await this.store.readOrDefault([]));
    return [...this.current];
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
