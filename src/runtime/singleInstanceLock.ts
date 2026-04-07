import { open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "#config/config.ts";

interface SingleInstanceLockMetadata {
  pid: number;
  appName: string;
  dataDir: string;
  instanceName: string | null;
  acquiredAt: string;
}

export class SingleInstanceLockError extends Error {
  constructor(
    readonly lockFilePath: string,
    readonly metadata: SingleInstanceLockMetadata | null
  ) {
    super(buildLockErrorMessage(lockFilePath, metadata));
    this.name = "SingleInstanceLockError";
  }
}

export class SingleInstanceLock {
  private readonly metadata: SingleInstanceLockMetadata;
  private readonly filePath: string;
  private released = false;

  private constructor(filePath: string, metadata: SingleInstanceLockMetadata) {
    this.filePath = filePath;
    this.metadata = metadata;
  }

  static async acquire(dataDir: string, config: AppConfig): Promise<SingleInstanceLock> {
    const filePath = join(dataDir, ".instance.lock");
    const metadata: SingleInstanceLockMetadata = {
      pid: process.pid,
      appName: config.appName,
      dataDir,
      instanceName: config.configRuntime.instanceName ?? null,
      acquiredAt: new Date().toISOString()
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(filePath, "wx");
        try {
          await handle.writeFile(`${JSON.stringify(metadata, null, 2)}\n`, "utf8");
        } finally {
          await handle.close();
        }
        return new SingleInstanceLock(filePath, metadata);
      } catch (error: unknown) {
        if (!isAlreadyExistsError(error)) {
          throw error;
        }

        const existingMetadata = await readLockMetadata(filePath);
        if (existingMetadata != null && isProcessAlive(existingMetadata.pid)) {
          throw new SingleInstanceLockError(filePath, existingMetadata);
        }

        await rm(filePath, { force: true });
      }
    }

    throw new Error(`Failed to acquire single-instance lock: ${filePath}`);
  }

  async release(): Promise<void> {
    if (this.released) {
      return;
    }
    this.released = true;

    const existingMetadata = await readLockMetadata(this.filePath);
    if (existingMetadata?.pid !== this.metadata.pid) {
      return;
    }

    await rm(this.filePath, { force: true });
  }
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error != null && "code" in error && error.code === "EEXIST";
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (typeof error === "object" && error != null && "code" in error && error.code === "ESRCH") {
      return false;
    }
    return true;
  }
}

async function readLockMetadata(filePath: string): Promise<SingleInstanceLockMetadata | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed == null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;

    const pid = typeof record.pid === "number" && Number.isInteger(record.pid) && record.pid > 0
      ? record.pid
      : null;
    const appName = typeof record.appName === "string" ? record.appName : null;
    const dataDir = typeof record.dataDir === "string" ? record.dataDir : null;
    const instanceName = typeof record.instanceName === "string" || record.instanceName === null
      ? record.instanceName
      : null;
    const acquiredAt = typeof record.acquiredAt === "string" ? record.acquiredAt : null;

    if (pid == null || appName == null || dataDir == null || acquiredAt == null) {
      return null;
    }

    return {
      pid,
      appName,
      dataDir,
      instanceName,
      acquiredAt
    };
  } catch {
    return null;
  }
}

function buildLockErrorMessage(filePath: string, metadata: SingleInstanceLockMetadata | null): string {
  if (metadata == null) {
    return `Another instance appears to be running (lock file: ${filePath}).`;
  }

  const instanceLabel = metadata.instanceName != null ? metadata.instanceName : "default";
  return `Another instance is already running for dataDir ${metadata.dataDir} (instance=${instanceLabel}, pid=${metadata.pid}, lock=${filePath}).`;
}
