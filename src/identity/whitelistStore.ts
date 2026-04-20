import { join } from "node:path";
import type { Logger } from "pino";
import { FileSchemaStore } from "#data/fileSchemaStore.ts";
import {
  whitelistFileSchema,
  type WhitelistFile
} from "./whitelistSchema.ts";

export interface WhitelistSnapshot {
  users: string[];
  groups: string[];
}

export class WhitelistStore {
  private readonly store: FileSchemaStore<typeof whitelistFileSchema>;
  private current: WhitelistSnapshot = emptyWhitelist();

  constructor(
    dataDir: string,
    private readonly logger: Logger
  ) {
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

  hasUser(userId: string): boolean {
    return this.current.users.includes(userId);
  }

  hasGroup(groupId: string): boolean {
    return this.current.groups.includes(groupId);
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
    const next = await this.readAll();
    this.current = next;
    await this.writeAll(next);
    return cloneSnapshot(next);
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
      users: normalized.users,
      groups: normalized.groups
    });
    this.current = normalized;
    return this.getSnapshot();
  }
}

function normalizeSnapshot(snapshot: WhitelistSnapshot | WhitelistFile): WhitelistSnapshot {
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
