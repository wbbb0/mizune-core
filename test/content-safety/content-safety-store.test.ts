import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { ContentSafetyStore } from "../../src/contentSafety/contentSafetyStore.ts";

async function withDataDir(name: string, fn: (dataDir: string) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), `${name}-`));
  try {
    await fn(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("content safety store persists audits in assets sqlite without legacy json output", async () => {
  await withDataDir("llm-bot-content-safety-store", async (dataDir) => {
    const store = new ContentSafetyStore(dataDir, pino({ level: "silent" }));
    await store.init();

    await store.upsert({
      key: "audit-1",
      subjectKind: "image",
      decision: "block",
      marker: "blocked",
      result: {
        decision: "block",
        reason: "blocked",
        labels: [],
        providerId: "local",
        providerType: "keyword",
        checkedAtMs: 123
      },
      fileId: "file_1",
      checkedAtMs: 123
    });

    assert.equal((await store.getByKey("audit-1"))?.fileId, "file_1");
    const assetFiles = await readdir(join(dataDir, "assets"), { withFileTypes: true });
    assert.equal(assetFiles.some((entry) => entry.isFile() && entry.name === "assets.sqlite"), true);
    assert.equal(assetFiles.some((entry) => entry.isFile() && entry.name === "results.json"), false);
  });
});

test("content safety store returns latest file and session views from sqlite", async () => {
  await withDataDir("llm-bot-content-safety-store-view", async (dataDir) => {
    const store = new ContentSafetyStore(dataDir, pino({ level: "silent" }));
    await store.init();

    await store.upsert({
      key: "audit-1",
      subjectKind: "image",
      decision: "review",
      marker: "review",
      result: {
        decision: "review",
        reason: "needs review",
        labels: [],
        providerId: "local",
        providerType: "keyword",
        checkedAtMs: 100
      },
      fileId: "file_1",
      sessionId: "s1",
      checkedAtMs: 100
    });
    await store.upsert({
      key: "audit-2",
      subjectKind: "image",
      decision: "block",
      marker: "blocked",
      result: {
        decision: "block",
        reason: "blocked",
        labels: [],
        providerId: "local",
        providerType: "keyword",
        checkedAtMs: 200
      },
      fileId: "file_1",
      sessionId: "s1",
      checkedAtMs: 200
    });

    assert.equal((await store.getByFileId("file_1"))?.key, "audit-2");
    assert.equal((await store.getViewByFileId("file_1"))?.decision, "block");
    assert.equal((await store.listBySessionId("s1")).length, 2);
    assert.deepEqual(await store.isBlockedFileId("file_1"), {
      blocked: true,
      marker: "blocked",
      reason: "blocked"
    });
  });
});