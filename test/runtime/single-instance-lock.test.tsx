import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SingleInstanceLock, SingleInstanceLockError } from "../../src/runtime/singleInstanceLock.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

async function withDataDir(name: string, fn: (dataDir: string) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), `${name}-`));
  try {
    await fn(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

function createTestConfig(_dataDir: string) {
  return createTestAppConfig({
    appName: "llm-bot-test"
  });
}

  test("acquires and releases the instance lock", async () => {
    await withDataDir("llm-bot-single-lock", async (dataDir) => {
      const lock = await SingleInstanceLock.acquire(dataDir, createTestConfig(dataDir));
      const filePath = join(dataDir, ".instance.lock");
      const content = JSON.parse(await readFile(filePath, "utf8")) as { pid: number };
      assert.equal(content.pid, process.pid);
      await lock.release();
      await assert.rejects(readFile(filePath, "utf8"));
    });
  });

  test("rejects when a live process already owns the lock", async () => {
    await withDataDir("llm-bot-single-lock-live", async (dataDir) => {
      const filePath = join(dataDir, ".instance.lock");
      await writeFile(filePath, `${JSON.stringify({
        pid: process.pid,
        appName: "llm-bot-test",
        dataDir,
        instanceName: "acc-test",
        acquiredAt: new Date().toISOString()
      })}\n`, "utf8");

      await assert.rejects(
        () => SingleInstanceLock.acquire(dataDir, createTestConfig(dataDir)),
        (error) => error instanceof SingleInstanceLockError && error.metadata?.pid === process.pid
      );
    });
  });

  test("replaces a stale lock file", async () => {
    await withDataDir("llm-bot-single-lock-stale", async (dataDir) => {
      const filePath = join(dataDir, ".instance.lock");
      await writeFile(filePath, `${JSON.stringify({
        pid: 999999,
        appName: "llm-bot-test",
        dataDir,
        instanceName: "acc-test",
        acquiredAt: new Date().toISOString()
      })}\n`, "utf8");

      const lock = await SingleInstanceLock.acquire(dataDir, createTestConfig(dataDir));
      const content = JSON.parse(await readFile(filePath, "utf8")) as { pid: number };
      assert.equal(content.pid, process.pid);
      await lock.release();
    });
  });
