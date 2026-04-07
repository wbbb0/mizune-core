import { join } from "node:path";
import type { Logger } from "pino";
import type { OneBotRequestEvent } from "#services/onebot/types.ts";
import { FileSchemaStore } from "#data/fileSchemaStore.ts";
import {
  requestFileSchema,
  type PendingFriendRequest,
  type PendingGroupRequest,
  type PendingRequest
} from "./requestSchema.ts";

export class RequestStore {
  private readonly store: FileSchemaStore<typeof requestFileSchema>;

  constructor(dataDir: string, private readonly logger: Logger) {
    this.store = new FileSchemaStore({
      filePath: join(dataDir, "pending-requests.json"),
      schema: requestFileSchema,
      logger,
      loadErrorEvent: "request_store_load_failed"
    });
  }

  async init(): Promise<void> {
    await this.readAll();
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
    const requests = await this.readAll();
    const next = requests.filter((item) => item.flag !== event.flag);

    if (event.request_type === "friend") {
      next.push({
        kind: "friend",
        flag: event.flag,
        userId: String(event.user_id),
        comment: String(event.comment ?? ""),
        createdAt: Date.now()
      });
    } else {
      next.push({
        kind: "group",
        flag: event.flag,
        userId: String(event.user_id),
        groupId: String(event.group_id),
        subType: event.sub_type,
        comment: String(event.comment ?? ""),
        createdAt: Date.now()
      });
    }

    await this.writeAll(next);
    this.logger.info({ kind: event.request_type, flag: event.flag }, "request_cached");
  }

  async remove(flag: string): Promise<void> {
    const requests = await this.readAll();
    const next = requests.filter((item) => item.flag !== flag);
    if (next.length === requests.length) {
      return;
    }
    await this.writeAll(next);
  }

  async get(flag: string): Promise<PendingRequest | null> {
    const requests = await this.readAll();
    return requests.find((item) => item.flag === flag) ?? null;
  }

  private async readAll(): Promise<PendingRequest[]> {
    try {
      const parsed = await this.store.readOrDefault({
        version: 1,
        requests: []
      });
      return [...parsed.requests];
    } catch (error: unknown) {
      this.logger.warn({ error }, "request_store_load_failed");
      throw error;
    }
  }

  private async writeAll(requests: PendingRequest[]): Promise<void> {
    await this.store.write({
      version: 1,
      requests
    });
  }
}
