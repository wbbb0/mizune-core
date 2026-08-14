import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireMinecraftClientProfileLock } from "../../src/services/minecraft/clientProfileLock.ts";

test("真实客户端 profile 锁原子拒绝第二个启动者，并可由原 owner 释放", async () => {
  const gameDirectory = await mkdtemp(join(tmpdir(), "minecraft-profile-lock-"));
  try {
    const first = await acquireMinecraftClientProfileLock(gameDirectory, "runtime-one");
    await assert.rejects(
      acquireMinecraftClientProfileLock(gameDirectory, "runtime-two"),
      /占用或留有待核验锁/u
    );
    await first.release();
    const second = await acquireMinecraftClientProfileLock(gameDirectory, "runtime-two");
    await second.release();
  } finally {
    await rm(gameDirectory, { recursive: true, force: true });
  }
});

test("profile 锁 owner 被篡改时拒绝删除锁目录", async () => {
  const gameDirectory = await mkdtemp(join(tmpdir(), "minecraft-profile-lock-owner-"));
  try {
    const lock = await acquireMinecraftClientProfileLock(gameDirectory, "runtime-owner");
    const ownerFile = join(lock.lockPath, "owner.json");
    const owner = JSON.parse(await readFile(ownerFile, "utf8")) as Record<string, unknown>;
    await writeFile(ownerFile, `${JSON.stringify({ ...owner, token: "different-owner" })}\n`, "utf8");
    await assert.rejects(lock.release(), /锁所有权已变化/u);
    await assert.rejects(
      acquireMinecraftClientProfileLock(gameDirectory, "runtime-other"),
      /待核验锁/u
    );
  } finally {
    await rm(gameDirectory, { recursive: true, force: true });
  }
});

test("同一 runtimeInstanceId 可接管父进程崩溃前留下的 profile 锁", async () => {
  const gameDirectory = await mkdtemp(join(tmpdir(), "minecraft-profile-lock-adopt-"));
  try {
    await acquireMinecraftClientProfileLock(gameDirectory, "runtime-stable");
    const adopted = await acquireMinecraftClientProfileLock(gameDirectory, "runtime-stable");
    assert.equal(adopted.ownerId, "runtime-stable");
    await adopted.release();
  } finally {
    await rm(gameDirectory, { recursive: true, force: true });
  }
});
