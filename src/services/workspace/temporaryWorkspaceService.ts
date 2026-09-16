import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "#config/config.ts";
import { LocalFileService } from "./localFileService.ts";

export interface WorkspaceActor { sessionId: string; userId: string }
export interface TemporaryWorkspace {
  resource_id: string;
  kind: "workspace";
  name: string;
  ownerSessionId: string;
  ownerUserId: string;
  createdAtMs: number;
  expiresAtMs: number;
  status: "active" | "expired" | "closed";
}
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Metadata lives outside files so filesystem tools cannot extend leases or change ownership. */
export class TemporaryWorkspaceService {
  private readonly records = new Map<string, TemporaryWorkspace>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly root: string;

  constructor(private readonly config: AppConfig, dataDir: string, private readonly onError: (error: unknown) => void = () => {}, private readonly now: () => number = Date.now) {
    this.root = join(dataDir, "temporary-workspaces");
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^ws_[a-f0-9]{32}$/.test(entry.name)) continue;
      try {
        const value: unknown = JSON.parse(await readFile(join(this.root, entry.name, "metadata.json"), "utf8"));
        if (!isRecord(value) || value.resource_id !== entry.name) throw new Error(`工作区元数据无效：${entry.name}`);
        this.records.set(entry.name, value);
        for (const child of await readdir(join(this.root, entry.name), { withFileTypes: true })) {
          if (child.isDirectory() && child.name.startsWith(".staging-")) await rm(join(this.root, entry.name, child.name), { recursive: true, force: true });
        }
      } catch (error) { this.onError(error); }
    }
    await this.sweep();
    this.timer = setInterval(() => { void this.sweep().catch(this.onError); }, HOUR_MS);
    this.timer.unref();
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.pending.values()]);
  }

  async create(actor: WorkspaceActor, name = "临时工作区"): Promise<TemporaryWorkspace> {
    if (!this.config.localFiles.enabled) throw new Error("文件工具未启用");
    if (!actor.sessionId || !actor.userId) throw new Error("创建工作区需要明确的会话与用户");
    const createdAtMs = this.now();
    const record: TemporaryWorkspace = {
      resource_id: `ws_${randomUUID().replaceAll("-", "")}`, kind: "workspace",
      name: name.trim().slice(0, 120) || "临时工作区", ownerSessionId: actor.sessionId, ownerUserId: actor.userId,
      createdAtMs, expiresAtMs: createdAtMs + DAY_MS, status: "active"
    };
    await mkdir(join(this.root, record.resource_id, "files"), { recursive: true });
    await this.persist(record);
    this.records.set(record.resource_id, record);
    return { ...record };
  }

  list(actor?: WorkspaceActor): TemporaryWorkspace[] {
    return [...this.records.values()].filter((record) => !actor || this.owns(record, actor))
      .map((record) => ({ ...record, status: record.status === "active" && record.expiresAtMs <= this.now() ? "expired" as const : record.status }))
      .sort((a, b) => b.createdAtMs - a.createdAtMs);
  }

  async withFiles<T>(id: string, actor: WorkspaceActor | null, operation: (files: LocalFileService, record: TemporaryWorkspace) => Promise<T>): Promise<T> {
    return this.serial(id, async () => {
      const record = this.requireRecord(id, actor);
      const assertActive = () => {
        if (record.status !== "active" || record.expiresAtMs <= this.now()) throw new Error("工作区已失效，请创建新工作区");
      };
      assertActive();
      const files = new LocalFileService(this.config, this.root, { root: join(this.root, id, "files"), assertActive });
      return operation(files, { ...record });
    });
  }

  async close(id: string, actor: WorkspaceActor | null): Promise<void> {
    await this.serial(id, async () => {
      const record = this.requireRecord(id, actor);
      if (record.status === "active") { record.status = "closed"; await this.persist(record); }
      await rm(join(this.root, id, "files"), { recursive: true, force: true });
    });
  }

  async sweep(): Promise<void> {
    for (const id of this.records.keys()) {
      await this.serial(id, async () => {
        const record = this.records.get(id)!;
        if (record.status === "active" && record.expiresAtMs > this.now()) return;
        if (record.status === "active") { record.status = "expired"; await this.persist(record); }
        await rm(join(this.root, id, "files"), { recursive: true, force: true });
        // Keep a short tombstone for old resource references, without accumulating records forever.
        if (record.expiresAtMs + DAY_MS <= this.now()) {
          await rm(join(this.root, id), { recursive: true, force: true });
          this.records.delete(id);
        }
      }).catch(this.onError);
    }
  }

  private requireRecord(id: string, actor: WorkspaceActor | null): TemporaryWorkspace {
    const record = this.records.get(id);
    if (!record || actor && !this.owns(record, actor)) throw new Error("工作区不存在或无权访问");
    return record;
  }
  private owns(record: TemporaryWorkspace, actor: WorkspaceActor): boolean {
    return record.ownerSessionId === actor.sessionId && record.ownerUserId === actor.userId;
  }
  private async persist(record: TemporaryWorkspace): Promise<void> {
    const target = join(this.root, record.resource_id, "metadata.json");
    await writeFile(`${target}.tmp`, JSON.stringify(record), { mode: 0o600 });
    await rename(`${target}.tmp`, target);
  }
  private async serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(id) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(operation);
    this.pending.set(id, task);
    try { return await task; } finally { if (this.pending.get(id) === task) this.pending.delete(id); }
  }
}

function isRecord(value: unknown): value is TemporaryWorkspace {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return typeof r.resource_id === "string" && r.kind === "workspace" && typeof r.name === "string"
    && typeof r.ownerSessionId === "string" && typeof r.ownerUserId === "string"
    && typeof r.createdAtMs === "number" && Number.isFinite(r.createdAtMs)
    && typeof r.expiresAtMs === "number" && Number.isFinite(r.expiresAtMs)
    && ["active", "expired", "closed"].includes(String(r.status));
}
