import { randomUUID } from "node:crypto";
import type {
  NewMinecraftActorOutboxEntry,
  RuntimeResourceStore
} from "./runtimeResourceStore.ts";
import type {
  BrowserPageRecoveryState,
  MinecraftActorRecoveryState,
  RuntimeResourceKind,
  RuntimeResourceRecord,
  RuntimeResourceStatus,
  ShellSessionRecoveryState
} from "./resourceTypes.ts";

export class RuntimeResourceRegistry {
  constructor(private readonly store: RuntimeResourceStore) {}

  async list(kind?: RuntimeResourceKind): Promise<RuntimeResourceRecord[]> {
    return this.store.list(kind);
  }

  async listActive(kind?: RuntimeResourceKind): Promise<RuntimeResourceRecord[]> {
    return this.store.listActive(kind);
  }

  async get(resourceId: string): Promise<RuntimeResourceRecord | null> {
    return this.store.getRow(resourceId);
  }

  async reset(): Promise<void> {
    await this.store.reset();
  }

  async resetEphemeral(): Promise<void> {
    await this.store.resetEphemeral();
  }

  async createBrowserPage(input: {
    ownerSessionId?: string | null;
    title: string | null;
    description?: string | null;
    summary: string;
    createdAtMs: number;
    expiresAtMs: number | null;
    browserPage: BrowserPageRecoveryState;
  }): Promise<RuntimeResourceRecord> {
    const resourceId = createRuntimeResourceId("res_browser");
    const record: RuntimeResourceRecord = {
      resourceId,
      kind: "browser_page",
      status: "active",
      ownerSessionId: input.ownerSessionId ?? null,
      title: input.title,
      description: normalizeOptionalDescription(input.description),
      summary: input.summary,
      createdAtMs: input.createdAtMs,
      lastAccessedAtMs: input.createdAtMs,
      expiresAtMs: input.expiresAtMs,
      browserPage: input.browserPage
    };
    await this.store.upsert(record);
    return record;
  }

  async createShellSession(input: {
    title: string | null;
    description?: string | null;
    summary: string;
    createdAtMs: number;
    expiresAtMs: number | null;
    shellSession: ShellSessionRecoveryState;
  }): Promise<RuntimeResourceRecord> {
    const resourceId = createRuntimeResourceId("res_shell");
    const record: RuntimeResourceRecord = {
      resourceId,
      kind: "shell_session",
      status: "active",
      ownerSessionId: null,
      title: input.title,
      description: normalizeOptionalDescription(input.description),
      summary: input.summary,
      createdAtMs: input.createdAtMs,
      lastAccessedAtMs: input.createdAtMs,
      expiresAtMs: input.expiresAtMs,
      shellSession: input.shellSession
    };
    await this.store.upsert(record);
    return record;
  }

  async createMinecraftActor(input: {
    ownerSessionId: string;
    ownerPrincipalId: string;
    title: string | null;
    description?: string | null;
    summary: string;
    createdAtMs: number;
    expiresAtMs: number | null;
    minecraftActor: MinecraftActorRecoveryState;
  }): Promise<RuntimeResourceRecord> {
    const resourceId = createRuntimeResourceId("res_minecraft");
    const record: RuntimeResourceRecord = {
      resourceId,
      kind: "minecraft_actor",
      status: "active",
      ownerSessionId: input.ownerSessionId,
      title: input.title,
      description: normalizeOptionalDescription(input.description),
      summary: input.summary,
      createdAtMs: input.createdAtMs,
      lastAccessedAtMs: input.createdAtMs,
      expiresAtMs: input.expiresAtMs,
      minecraftActor: input.minecraftActor
    };
    await this.store.upsert(record, { minecraftOwnerPrincipalId: input.ownerPrincipalId });
    return record;
  }

  async updateMinecraftActor(
    resourceId: string,
    minecraftActor: MinecraftActorRecoveryState,
    input: { updatedAtMs: number; summary?: string }
  ): Promise<RuntimeResourceRecord | null> {
    const updated = await this.store.updateActiveMinecraftActor(resourceId, minecraftActor, input);
    return updated ? this.store.getRow(resourceId) : null;
  }

  async recordMinecraftActorEvents(input: {
    resourceId: string;
    lastEventSequence: number;
    entries: NewMinecraftActorOutboxEntry[];
    updatedAtMs: number;
  }): Promise<boolean> {
    return this.store.recordMinecraftActorEvents(
      input.resourceId,
      input.lastEventSequence,
      input.entries,
      input.updatedAtMs
    );
  }

  async listPendingMinecraftActorOutbox(resourceId: string) {
    return this.store.listPendingMinecraftActorOutbox(resourceId);
  }

  async markMinecraftActorOutboxDelivered(resourceId: string, outboxId: string, deliveredAtMs: number) {
    return this.store.markMinecraftActorOutboxDelivered(resourceId, outboxId, deliveredAtMs);
  }

  async markMinecraftActorOutboxFailed(resourceId: string, outboxId: string, error: string) {
    return this.store.markMinecraftActorOutboxFailed(resourceId, outboxId, error);
  }

  async touch(resourceId: string, input: {
    accessedAtMs: number;
    expiresAtMs?: number | null;
    title?: string | null;
    description?: string | null;
    summary?: string;
    status?: RuntimeResourceStatus;
  }): Promise<RuntimeResourceRecord | null> {
    const patch: Parameters<RuntimeResourceStore["update"]>[1] = {
      lastAccessedAtMs: input.accessedAtMs
    };
    if (input.expiresAtMs !== undefined) patch.expiresAtMs = input.expiresAtMs;
    if (input.status !== undefined) patch.status = input.status;
    if (input.title !== undefined) patch.title = input.title;
    if (input.description !== undefined) patch.description = normalizeOptionalDescription(input.description);
    if (input.summary !== undefined) patch.summary = input.summary;
    return this.store.update(resourceId, patch);
  }

  async markStatus(resourceId: string, status: RuntimeResourceStatus, updatedAtMs: number): Promise<RuntimeResourceRecord | null> {
    return this.touch(resourceId, {
      accessedAtMs: updatedAtMs,
      status
    });
  }
}

function createRuntimeResourceId(prefix: "res_browser" | "res_shell" | "res_minecraft"): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function normalizeOptionalDescription(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}
