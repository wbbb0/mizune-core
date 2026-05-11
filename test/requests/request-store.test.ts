import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { RequestStore } from "../../src/requests/requestStore.ts";

async function createHarness() {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-request-store-test-"));
  const store = new RequestStore(dataDir, pino({ level: "silent" }));
  await store.init();
  return {
    dataDir,
    store,
    cleanup: async () => {
      await rm(dataDir, { recursive: true, force: true });
    }
  };
}

test("RequestStore persists requests in state sqlite without legacy json output", async () => {
  const harness = await createHarness();
  try {
    await harness.store.upsertFromEvent({
      post_type: "request",
      request_type: "friend",
      self_id: 1,
      time: 1,
      user_id: 10001,
      flag: "friend-flag",
      comment: "hello"
    });
    await harness.store.upsertFromEvent({
      post_type: "request",
      request_type: "group",
      self_id: 1,
      time: 1,
      user_id: 10002,
      group_id: 20001,
      flag: "group-flag",
      sub_type: "add",
      comment: "join"
    });

    assert.deepEqual((await harness.store.listFriendRequests()).map((request) => request.flag), ["friend-flag"]);
    assert.deepEqual((await harness.store.listGroupRequests()).map((request) => request.flag), ["group-flag"]);
    assert.equal((await harness.store.get("group-flag"))?.kind, "group");
    await assert.rejects(access(join(harness.dataDir, "pending-requests.json")), /ENOENT/u);
  } finally {
    await harness.cleanup();
  }
});

test("RequestStore ignores existing legacy pending requests json", async () => {
  const harness = await createHarness();
  try {
    await writeFile(join(harness.dataDir, "pending-requests.json"), JSON.stringify({
      version: 1,
      requests: [{
        kind: "friend",
        flag: "legacy",
        userId: "10001",
        comment: "",
        createdAt: 1
      }]
    }), "utf8");

    assert.equal(await harness.store.get("legacy"), null);
    assert.equal((await harness.store.listRows()).total, 0);
  } finally {
    await harness.cleanup();
  }
});

test("RequestStore row creation rejects duplicates and preserves existing row", async () => {
  const harness = await createHarness();
  try {
    await harness.store.createRow({
      kind: "friend",
      flag: "friend-flag",
      userId: "10001",
      comment: "hello",
      createdAt: 1
    });
    await assert.rejects(
      () => harness.store.createRow({
        kind: "friend",
        flag: "friend-flag",
        userId: "10001",
        comment: "overwrite",
        createdAt: 2
      }),
      /already exists/u
    );
    assert.equal((await harness.store.get("friend-flag"))?.comment, "hello");

    const patched = await harness.store.patchRow("friend-flag", { comment: "updated" });
    assert.equal(patched.comment, "updated");
    await assert.rejects(
      () => harness.store.patchRow("friend-flag", { flag: "changed" }),
      /flag cannot be changed/u
    );

    await harness.store.deleteRow("friend-flag");
    assert.equal(await harness.store.get("friend-flag"), null);
  } finally {
    await harness.cleanup();
  }
});

test("RequestStore keeps insertion order for requests with the same timestamp", async () => {
  const harness = await createHarness();
  try {
    await harness.store.createRow({
      kind: "friend",
      flag: "flag-b",
      userId: "10001",
      comment: "",
      createdAt: 1
    });
    await harness.store.createRow({
      kind: "friend",
      flag: "flag-a",
      userId: "10002",
      comment: "",
      createdAt: 1
    });
    assert.deepEqual((await harness.store.listRows()).rows.map((request) => request.flag), ["flag-b", "flag-a"]);

    await harness.store.upsertFromEvent({
      post_type: "request",
      request_type: "friend",
      self_id: 1,
      time: 1,
      user_id: 10001,
      flag: "flag-b",
      comment: "moved"
    });
    assert.deepEqual((await harness.store.listRows()).rows.map((request) => request.flag), ["flag-a", "flag-b"]);
  } finally {
    await harness.cleanup();
  }
});
