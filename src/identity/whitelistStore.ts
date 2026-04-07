import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import { FileSchemaStore } from "#data/fileSchemaStore.ts";
import {
  legacyOwnerRecordSchema,
  whitelistFileSchema,
  type WhitelistFile
} from "./whitelistSchema.ts";

export interface WhitelistSnapshot {
  ownerId?: string;
  users: string[];
  groups: string[];
}

export class WhitelistStore {
  private readonly store: FileSchemaStore<typeof whitelistFileSchema>;
  private readonly legacyOwnerFilePath: string;
  private current: WhitelistSnapshot = emptyWhitelist();

  constructor(
    dataDir: string,
    private readonly logger: Logger
  ) {
    this.legacyOwnerFilePath = join(dataDir, "owner.json");
    this.store = new FileSchemaStore({
      filePath: join(dataDir, "whitelist.json"),
      schema: whitelistFileSchema,
      logger,
      loadErrorEvent: "whitelist_data_load_failed"
    });
  }

  async init(): Promise<void> {
    await this.reloadFromDisk();
  }

  getSnapshot(): WhitelistSnapshot {
    return cloneSnapshot(this.current);
  }

  getOwnerId(): string | undefined {
    return this.current.ownerId;
  }

  hasUser(userId: string): boolean {
    return this.current.users.includes(userId);
  }

  hasGroup(groupId: string): boolean {
    return this.current.groups.includes(groupId);
  }

  async assignOwner(userId: string): Promise<string> {
    const normalizedUserId = legacyOwnerRecordSchema.parse({ ownerQq: userId }).ownerQq;
    const next = await this.writeAll({
      ...this.current,
      ownerId: normalizedUserId,
      users: uniqueSorted([...this.current.users, normalizedUserId])
    });
    this.logger.info({ ownerId: next.ownerId }, "owner_persisted");
    return next.ownerId ?? normalizedUserId;
  }

  async addUser(userId: string): Promise<string[]> {
    const next = await this.writeAll({
      ...this.current,
      users: uniqueSorted([...this.current.users, userId])
    });
    this.logger.info({ userCount: next.users.length, groupCount: next.groups.length }, "whitelist_persisted");
    return [...next.users];
  }

  async removeUser(userId: string): Promise<string[]> {
    const next = await this.writeAll({
      ...this.current,
      users: this.current.users.filter((item) => item !== userId)
    });
    this.logger.info({ userCount: next.users.length, groupCount: next.groups.length }, "whitelist_persisted");
    return [...next.users];
  }

  async addGroup(groupId: string): Promise<string[]> {
    const next = await this.writeAll({
      ...this.current,
      groups: uniqueSorted([...this.current.groups, groupId])
    });
    this.logger.info({ userCount: next.users.length, groupCount: next.groups.length }, "whitelist_persisted");
    return [...next.groups];
  }

  async removeGroup(groupId: string): Promise<string[]> {
    const next = await this.writeAll({
      ...this.current,
      groups: this.current.groups.filter((item) => item !== groupId)
    });
    this.logger.info({ userCount: next.users.length, groupCount: next.groups.length }, "whitelist_persisted");
    return [...next.groups];
  }

  async ensureUser(userId: string): Promise<string[]> {
    return this.addUser(userId);
  }

  async reloadFromDisk(): Promise<WhitelistSnapshot> {
    const current = await this.readAll();
    const next = await this.mergeLegacyOwner(current);
    this.current = next;
    await this.writeAll(next);
    return this.getSnapshot();
  }

  private async readAll(): Promise<WhitelistSnapshot> {
    try {
      const parsed = await this.store.readOrDefault({
        version: 2,
        users: [],
        groups: []
      });
      return normalizeSnapshot(parsed);
    } catch (error: unknown) {
      this.logger.warn({ error }, "whitelist_data_load_failed");
      throw error;
    }
  }

  private async writeAll(snapshot: WhitelistSnapshot): Promise<WhitelistSnapshot> {
    const normalized = normalizeSnapshot(snapshot);
    await this.store.write({
      version: 2,
      ...(normalized.ownerId ? { ownerId: normalized.ownerId } : {}),
      users: normalized.users,
      groups: normalized.groups
    });
    this.current = normalized;
    return this.getSnapshot();
  }

  private async mergeLegacyOwner(snapshot: WhitelistSnapshot): Promise<WhitelistSnapshot> {
    if (snapshot.ownerId) {
      return snapshot;
    }
    const legacyOwnerId = await this.readLegacyOwnerId();
    if (!legacyOwnerId) {
      return snapshot;
    }
    return normalizeSnapshot({
      ...snapshot,
      ownerId: legacyOwnerId,
      users: [...snapshot.users, legacyOwnerId]
    });
  }

  private async readLegacyOwnerId(): Promise<string | undefined> {
    try {
      const raw = await readFile(this.legacyOwnerFilePath, "utf8");
      return legacyOwnerRecordSchema.parse(JSON.parse(raw)).ownerQq;
    } catch (error: unknown) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return undefined;
      }
      this.logger.warn({ error, filePath: this.legacyOwnerFilePath }, "owner_data_load_failed");
      throw error;
    }
  }
}

function normalizeSnapshot(snapshot: WhitelistSnapshot | WhitelistFile): WhitelistSnapshot {
  const ownerId = getOwnerId(snapshot);
  return {
    ...(ownerId ? { ownerId: ownerId.trim() } : {}),
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

function getOwnerId(snapshot: WhitelistSnapshot | WhitelistFile): string | undefined {
  if ("ownerId" in snapshot) {
    return snapshot.ownerId;
  }
  return undefined;
}

function cloneSnapshot(snapshot: WhitelistSnapshot): WhitelistSnapshot {
  return {
    ...(snapshot.ownerId ? { ownerId: snapshot.ownerId } : {}),
    users: [...snapshot.users],
    groups: [...snapshot.groups]
  };
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}
