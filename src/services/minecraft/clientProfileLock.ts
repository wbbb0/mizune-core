import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readLinuxProcessIdentity } from "./processIdentity.ts";

interface ProfileLockOwner {
  version: 1;
  ownerId: string;
  token: string;
  pid: number;
  startTicks: string;
  bootId: string;
  createdAtMs: number;
}

export interface MinecraftClientProfileLock {
  lockPath: string;
  ownerId: string;
  release(): Promise<void>;
}

export async function acquireMinecraftClientProfileLock(
  gameDirectory: string,
  ownerId: string
): Promise<MinecraftClientProfileLock> {
  if (!ownerId.trim() || ownerId.length > 256 || ownerId.includes("\0")) {
    throw new Error("Minecraft clientProfile lock ownerId 无效");
  }
  const normalizedGameDirectory = resolve(gameDirectory);
  const [directoryStat, canonicalDirectory] = await Promise.all([
    lstat(normalizedGameDirectory),
    realpath(normalizedGameDirectory)
  ]);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`Minecraft clientProfile gameDirectory 必须是真实目录：${normalizedGameDirectory}`);
  }
  if (canonicalDirectory !== normalizedGameDirectory) {
    throw new Error(`Minecraft clientProfile gameDirectory 不允许经过符号链接：${normalizedGameDirectory}`);
  }
  if (typeof process.getuid === "function" && directoryStat.uid !== process.getuid()) {
    throw new Error(`Minecraft clientProfile gameDirectory 不属于当前用户：${normalizedGameDirectory}`);
  }
  if ((directoryStat.mode & 0o077) !== 0) {
    throw new Error(`Minecraft clientProfile gameDirectory 必须禁止 group/other 访问：${normalizedGameDirectory}`);
  }

  const lockPath = join(normalizedGameDirectory, ".mizune-managed-profile.lock");
  const ownerFile = join(lockPath, "owner.json");
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    const existing = parseOwner(await readFile(ownerFile, "utf8"));
    if (existing.ownerId !== ownerId) {
      throw new Error(
        `Minecraft clientProfile 已被其他 Runtime 占用或留有待核验锁：${lockPath}；不得自动删除`
      );
    }
    return createLockHandle(lockPath, ownerFile, existing);
  }

  const identity = await readLinuxProcessIdentity(process.pid);
  if (!identity) {
    await rmdir(lockPath).catch(() => undefined);
    throw new Error("无法读取 clientProfile lock 进程身份");
  }
  const owner: ProfileLockOwner = {
    version: 1,
    ownerId,
    token: randomUUID(),
    pid: identity.pid,
    startTicks: identity.startTicks,
    bootId: identity.bootId,
    createdAtMs: Date.now()
  };
  try {
    await writeFile(ownerFile, `${JSON.stringify(owner)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    await rmdir(lockPath).catch(() => undefined);
    throw error;
  }
  return createLockHandle(lockPath, ownerFile, owner);
}

function createLockHandle(
  lockPath: string,
  ownerFile: string,
  owner: ProfileLockOwner
): MinecraftClientProfileLock {
  let released = false;
  return {
    lockPath,
    ownerId: owner.ownerId,
    async release() {
      if (released) return;
      const current = parseOwner(await readFile(ownerFile, "utf8"));
      if (current.ownerId !== owner.ownerId || current.token !== owner.token) {
        throw new Error(`Minecraft clientProfile 锁所有权已变化，拒绝删除：${lockPath}`);
      }
      await unlink(ownerFile);
      await rmdir(lockPath);
      released = true;
    }
  };
}

function parseOwner(raw: string): ProfileLockOwner {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Minecraft clientProfile 锁 owner.json 不是有效 JSON");
  }
  if (
    !isRecord(value)
    || Object.keys(value).sort().join(",") !== "bootId,createdAtMs,ownerId,pid,startTicks,token,version"
    || value.version !== 1
    || typeof value.ownerId !== "string"
    || value.ownerId.length < 1
    || value.ownerId.length > 256
    || typeof value.token !== "string"
    || value.token.length < 1
    || !Number.isSafeInteger(value.pid)
    || Number(value.pid) <= 0
    || typeof value.startTicks !== "string"
    || !/^\d+$/u.test(value.startTicks)
    || typeof value.bootId !== "string"
    || value.bootId.length < 1
    || !Number.isSafeInteger(value.createdAtMs)
    || Number(value.createdAtMs) < 0
  ) {
    throw new Error("Minecraft clientProfile 锁 owner.json 结构无效");
  }
  return value as unknown as ProfileLockOwner;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
