import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Logger } from "pino";
import { FileSchemaStore } from "#data/fileSchemaStore.ts";
import type {
  BrowserPageRecoveryState,
  ShellSessionRecoveryState,
  RuntimeResourceKind,
  RuntimeResourceRecord,
  RuntimeResourceStatus
} from "./resourceTypes.ts";
import { runtimeResourceFileSchema, type RuntimeResourceFile } from "./runtimeResourceSchema.ts";

export class RuntimeResourceRegistry {
  private readonly store: FileSchemaStore<typeof runtimeResourceFileSchema>;

  constructor(dataDir: string, logger: Logger) {
    this.store = new FileSchemaStore({
      filePath: join(dataDir, "runtime-resources.json"),
      schema: runtimeResourceFileSchema,
      logger,
      loadErrorEvent: "runtime_resource_registry_load_failed",
      atomicWrite: true
    });
  }

  async list(kind?: RuntimeResourceKind): Promise<RuntimeResourceRecord[]> {
    const current = await this.store.readOrDefault({ resources: [] });
    const items = current.resources
      .filter((item) => !kind || item.kind === kind)
      .sort((left, right) => right.lastAccessedAtMs - left.lastAccessedAtMs);
    return items.map((item) => ({ ...item }));
  }

  async listActive(kind?: RuntimeResourceKind): Promise<RuntimeResourceRecord[]> {
    const items = await this.list(kind);
    return items.filter((item) => item.status === "active");
  }

  async reset(): Promise<void> {
    await this.store.write({ resources: [] });
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
    await this.store.updateExisting((current) => ({
      resources: upsertResource(current.resources, record)
    }), () => ({ resources: [record] }));
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
    await this.store.updateExisting((current) => ({
      resources: upsertResource(current.resources, record)
    }), () => ({ resources: [record] }));
    return record;
  }

  async touch(resourceId: string, input: {
    accessedAtMs: number;
    expiresAtMs?: number | null;
    title?: string | null;
    description?: string | null;
    summary?: string;
    status?: RuntimeResourceStatus;
  }): Promise<RuntimeResourceRecord | null> {
    let updated: RuntimeResourceRecord | null = null;
    await this.store.updateExisting((current) => ({
      resources: current.resources.map((item) => {
        if (item.resourceId !== resourceId) {
          return item;
        }
        updated = {
          ...item,
          lastAccessedAtMs: input.accessedAtMs,
          expiresAtMs: input.expiresAtMs === undefined ? item.expiresAtMs : input.expiresAtMs,
          title: input.title === undefined ? item.title : input.title,
          description: input.description === undefined ? item.description : normalizeOptionalDescription(input.description),
          summary: input.summary ?? item.summary,
          status: input.status ?? item.status
        };
        return updated;
      })
    }), () => ({ resources: [] }));
    return updated;
  }

  async markStatus(resourceId: string, status: RuntimeResourceStatus, updatedAtMs: number): Promise<RuntimeResourceRecord | null> {
    return this.touch(resourceId, {
      accessedAtMs: updatedAtMs,
      status
    });
  }
}

function upsertResource(resources: RuntimeResourceRecord[], next: RuntimeResourceRecord): RuntimeResourceRecord[] {
  const withoutCurrent = resources.filter((item) => item.resourceId !== next.resourceId);
  return [...withoutCurrent, next];
}

function createRuntimeResourceId(prefix: "res_browser" | "res_shell"): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function normalizeOptionalDescription(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}
