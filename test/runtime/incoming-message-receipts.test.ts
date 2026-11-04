import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { StateDatabase } from "../../src/data/state/stateDatabase.ts";
import { IncomingMessageReceiptStore } from "../../src/data/state/incomingMessageReceiptStore.ts";

const receipt = { connectionId: "qq_official.app", chatType: "group" as const, targetId: "group", messageId: "message", activated: false };

test("receipts persist context-to-activation upgrades and isolate connection, target and scene", async () => {
  const directory = await mkdtemp(join(tmpdir(), "message-receipts-"));
  const logger = pino({ level: "silent" });
  let database = new StateDatabase(directory, logger);
  try {
    await database.init();
    let store = new IncomingMessageReceiptStore(database);
    assert.equal(store.claim(receipt), "accepted");
    assert.equal(store.claim(receipt), "duplicate");
    database.close();
    database = new StateDatabase(directory, logger);
    await database.init();
    store = new IncomingMessageReceiptStore(database);
    assert.equal(store.claim({ ...receipt, activated: true }), "upgrade");
    assert.equal(store.claim({ ...receipt, activated: true }), "duplicate");
    assert.equal(store.claim(receipt), "duplicate");
    assert.equal(store.claim({ ...receipt, connectionId: "qq_official.other" }), "accepted");
    assert.equal(store.claim({ ...receipt, targetId: "other-group" }), "accepted");
    assert.equal(store.claim({ ...receipt, chatType: "private" }), "accepted");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("receipt capacity never evicts live claims and expired receipts release capacity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "message-receipts-capacity-"));
  const database = new StateDatabase(directory, pino({ level: "silent" }));
  let now = 1000;
  try {
    await database.init();
    const db = database.getDb();
    const insert = db.prepare(`INSERT INTO incoming_message_receipts VALUES ('qq_official.app', 'group', 'group', ?, 0, ?)`);
    db.transaction(() => { for (let i = 0; i < 10_000; i++) insert.run(`existing-${i}`, now + 600_000); })();
    const store = new IncomingMessageReceiptStore(database, () => now);
    assert.throws(() => store.claim(receipt), /容量上限/);
    assert.equal(store.claim({ ...receipt, messageId: "existing-0", activated: true }), "upgrade");
    assert.equal(store.claim({ ...receipt, messageId: "existing-0" }), "duplicate");
    now += 600_000;
    assert.equal(store.claim(receipt), "accepted");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM incoming_message_receipts").get() as { count: number }).count, 1);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
