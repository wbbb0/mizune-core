import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";

export interface BrowserProfileMeta {
  profileId: string;
  ownerSessionId: string;
  createdAtMs: number;
  lastUsedAtMs: number;
}

export interface BrowserProfileSnapshot {
  profileId: string;
  ownerSessionId: string;
  createdAtMs: number;
  lastUsedAtMs: number;
  storageState: unknown | null;
  sessionStorageByOrigin: Record<string, Record<string, string>>;
}

export interface BrowserProfileSummary {
  profile_id: string;
  ownerSessionId: string;
  createdAtMs: number;
  lastUsedAtMs: number;
  origins: string[];
  hasStorageState: boolean;
  hasSessionStorage: boolean;
}

const META_FILE = "profile-meta.json";
const STORAGE_STATE_FILE = "storage-state.json";
const SESSION_STORAGE_FILE = "session-storage.json";
const BROWSER_PROFILE_ID_PATTERN = /^browser_profile_[a-f0-9]{16}$/;

export class BrowserProfileStore {
  private readonly rootDir: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    dataDir: string,
    private readonly config: AppConfig,
    private readonly logger: Logger
  ) {
    this.rootDir = resolve(dataDir, "browser-profiles");
  }

  async ensureProfile(ownerSessionId: string): Promise<BrowserProfileMeta> {
    const normalizedOwnerSessionId = String(ownerSessionId ?? "").trim();
    if (!normalizedOwnerSessionId) {
      throw new Error("ownerSessionId is required");
    }

    const profileId = buildProfileId(this.config.configRuntime.instanceName, normalizedOwnerSessionId);
    return this.withWriteLock(async () => {
      await mkdir(this.rootDir, { recursive: true });
      const now = Date.now();
      const existing = await this.readMeta(profileId);
      const meta: BrowserProfileMeta = existing ?? {
        profileId,
        ownerSessionId: normalizedOwnerSessionId,
        createdAtMs: now,
        lastUsedAtMs: now
      };
      if (existing) {
        meta.lastUsedAtMs = now;
      }
      await this.writeMeta(meta);
      await this.trimProfiles();
      return meta;
    });
  }

  async loadProfile(profileId: string): Promise<BrowserProfileSnapshot | null> {
    const normalizedProfileId = normalizeBrowserProfileIdOrNull(profileId);
    if (!normalizedProfileId) {
      return null;
    }
    const meta = await this.readMeta(normalizedProfileId);
    if (!meta) {
      return null;
    }
    return {
      ...meta,
      storageState: await this.readJson(this.storageStatePath(normalizedProfileId)),
      sessionStorageByOrigin: await this.readSessionStorage(normalizedProfileId)
    };
  }

  async saveProfile(input: {
    profileId: string;
    ownerSessionId: string;
    storageState: unknown | null;
    sessionStorageByOrigin: Record<string, Record<string, string>>;
  }): Promise<BrowserProfileSnapshot> {
    const profileId = normalizeBrowserProfileId(input.profileId);
    const ownerSessionId = String(input.ownerSessionId ?? "").trim();
    if (!ownerSessionId) {
      throw new Error("ownerSessionId is required");
    }

    return this.withWriteLock(async () => {
      await mkdir(this.profileDir(profileId), { recursive: true });
      const previous = await this.readMeta(profileId);
      const now = Date.now();
      const meta: BrowserProfileMeta = {
        profileId,
        ownerSessionId,
        createdAtMs: previous?.createdAtMs ?? now,
        lastUsedAtMs: now
      };
      await this.writeMeta(meta);
      await this.writeJson(this.storageStatePath(profileId), input.storageState ?? null);
      await this.writeJson(this.sessionStoragePath(profileId), normalizeSessionStorageByOrigin(input.sessionStorageByOrigin));
      await this.trimProfiles();
      return {
        ...meta,
        storageState: input.storageState ?? null,
        sessionStorageByOrigin: normalizeSessionStorageByOrigin(input.sessionStorageByOrigin)
      };
    });
  }

  async markUsed(profileId: string): Promise<BrowserProfileMeta | null> {
    return this.withWriteLock(async () => {
      const meta = await this.readMeta(profileId);
      if (!meta) {
        return null;
      }
      const next = {
        ...meta,
        lastUsedAtMs: Date.now()
      };
      await this.writeMeta(next);
      return next;
    });
  }

  async listProfiles(): Promise<BrowserProfileSummary[]> {
    await mkdir(this.rootDir, { recursive: true });
    const entries = await readdir(this.rootDir, { withFileTypes: true }).catch(() => []);
    const summaries: BrowserProfileSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const profileId = normalizeBrowserProfileIdOrNull(entry.name);
      if (!profileId) {
        continue;
      }
      const meta = await this.readMeta(profileId);
      if (!meta) {
        continue;
      }
      const sessionStorage = await this.readSessionStorage(profileId);
      const storageStatePath = this.storageStatePath(profileId);
      summaries.push({
        profile_id: profileId,
        ownerSessionId: meta.ownerSessionId,
        createdAtMs: meta.createdAtMs,
        lastUsedAtMs: meta.lastUsedAtMs,
        origins: Object.keys(sessionStorage).sort((left, right) => left.localeCompare(right)),
        hasStorageState: await fileExists(storageStatePath),
        hasSessionStorage: Object.keys(sessionStorage).length > 0
      });
    }
    return summaries.sort((left, right) => right.lastUsedAtMs - left.lastUsedAtMs);
  }

  async clearProfile(profileId: string): Promise<boolean> {
    const normalizedProfileId = normalizeBrowserProfileIdOrNull(profileId);
    if (!normalizedProfileId) {
      return false;
    }
    return this.withWriteLock(() => this.clearProfileUnlocked(normalizedProfileId));
  }

  private async clearProfileUnlocked(profileId: string): Promise<boolean> {
    const normalizedProfileId = normalizeBrowserProfileId(profileId);
    const dirPath = this.profileDir(normalizedProfileId);
    const existed = await fileExists(dirPath);
    await rm(dirPath, { recursive: true, force: true });
    return existed;
  }

  async inspectProfile(profileId: string): Promise<BrowserProfileSummary | null> {
    const snapshot = await this.loadProfile(profileId);
    if (!snapshot) {
      return null;
    }
    return {
      profile_id: snapshot.profileId,
      ownerSessionId: snapshot.ownerSessionId,
      createdAtMs: snapshot.createdAtMs,
      lastUsedAtMs: snapshot.lastUsedAtMs,
      origins: Object.keys(snapshot.sessionStorageByOrigin).sort((left, right) => left.localeCompare(right)),
      hasStorageState: snapshot.storageState != null,
      hasSessionStorage: Object.keys(snapshot.sessionStorageByOrigin).length > 0
    };
  }

  private async trimProfiles(): Promise<void> {
    const limit = this.config.browser.playwright.profileMaxCount;
    if (!Number.isInteger(limit) || limit <= 0) {
      return;
    }
    const profiles = await this.listProfiles();
    const overflow = profiles.slice(limit);
    for (const item of overflow) {
      await this.clearProfileUnlocked(item.profile_id);
      this.logger.info({ profileId: item.profile_id }, "browser_profile_trimmed");
    }
  }

  private async readMeta(profileId: string): Promise<BrowserProfileMeta | null> {
    const raw = await this.readJson(this.metaPath(profileId));
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const value = raw as Record<string, unknown>;
    const profileIdValue = normalizeBrowserProfileIdOrNull(String(value.profileId ?? ""));
    const ownerSessionId = String(value.ownerSessionId ?? "").trim();
    const createdAtMs = Number(value.createdAtMs ?? 0);
    const lastUsedAtMs = Number(value.lastUsedAtMs ?? 0);
    if (!profileIdValue || !ownerSessionId || !Number.isFinite(createdAtMs) || !Number.isFinite(lastUsedAtMs)) {
      return null;
    }
    return {
      profileId: profileIdValue,
      ownerSessionId,
      createdAtMs: Math.max(0, Math.round(createdAtMs)),
      lastUsedAtMs: Math.max(0, Math.round(lastUsedAtMs))
    };
  }

  private async readSessionStorage(profileId: string): Promise<Record<string, Record<string, string>>> {
    const raw = await this.readJson(this.sessionStoragePath(profileId));
    return normalizeSessionStorageByOrigin(raw);
  }

  private async writeMeta(meta: BrowserProfileMeta): Promise<void> {
    await mkdir(this.profileDir(meta.profileId), { recursive: true });
    await this.writeJson(this.metaPath(meta.profileId), meta);
  }

  private async readJson(filePath: string): Promise<unknown | null> {
    try {
      const raw = await readFile(filePath, "utf8");
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }

  private async writeJson(filePath: string, value: unknown): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  private profileDir(profileId: string): string {
    const normalizedProfileId = normalizeBrowserProfileId(profileId);
    const dirPath = resolve(this.rootDir, normalizedProfileId);
    const relativeFromRoot = relative(this.rootDir, dirPath);
    if (relativeFromRoot === ".." || relativeFromRoot.startsWith("../") || isAbsolute(relativeFromRoot)) {
      throw new Error("invalid browser profile id");
    }
    return dirPath;
  }

  private metaPath(profileId: string): string {
    return join(this.profileDir(profileId), META_FILE);
  }

  private storageStatePath(profileId: string): string {
    return join(this.profileDir(profileId), STORAGE_STATE_FILE);
  }

  private sessionStoragePath(profileId: string): string {
    return join(this.profileDir(profileId), SESSION_STORAGE_FILE);
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeChain;
    let resolveCurrent: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      resolveCurrent = resolve;
    });
    const chain = previous.catch(() => undefined).then(() => current);
    this.writeChain = chain;
    try {
      await previous.catch(() => undefined);
      return await operation();
    } finally {
      resolveCurrent?.();
      if (this.writeChain === chain) {
        this.writeChain = Promise.resolve();
      }
    }
  }
}

function buildProfileId(instanceName: string, ownerSessionId: string): string {
  const hash = createHash("sha1")
    .update(`${instanceName}:${ownerSessionId}`)
    .digest("hex")
    .slice(0, 16);
  return `browser_profile_${hash}`;
}

function normalizeBrowserProfileId(profileId: string): string {
  const normalizedProfileId = String(profileId ?? "").trim();
  if (!BROWSER_PROFILE_ID_PATTERN.test(normalizedProfileId)) {
    throw new Error("invalid browser profile id");
  }
  return normalizedProfileId;
}

function normalizeBrowserProfileIdOrNull(profileId: string): string | null {
  const normalizedProfileId = String(profileId ?? "").trim();
  return BROWSER_PROFILE_ID_PATTERN.test(normalizedProfileId) ? normalizedProfileId : null;
}

function normalizeSessionStorageByOrigin(
  value: unknown
): Record<string, Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const next: Record<string, Record<string, string>> = {};
  for (const [origin, rawEntries] of Object.entries(value as Record<string, unknown>)) {
    const normalizedOrigin = String(origin ?? "").trim();
    if (!normalizedOrigin || !rawEntries || typeof rawEntries !== "object" || Array.isArray(rawEntries)) {
      continue;
    }
    const entries: Record<string, string> = {};
    for (const [key, rawItem] of Object.entries(rawEntries as Record<string, unknown>)) {
      const normalizedKey = String(key ?? "");
      if (!normalizedKey) {
        continue;
      }
      entries[normalizedKey] = String(rawItem ?? "");
    }
    if (Object.keys(entries).length > 0) {
      next[normalizedOrigin] = entries;
    }
  }
  return next;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
