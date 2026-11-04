import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { SqliteService } from "../../src/data/sqlite/sqliteService.ts";
import { UserIdentityStore } from "../../src/identity/userIdentityStore.ts";

  test("identity store binds one external identity to owner", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-user-identities-owner-"));
    try {
      const store = new UserIdentityStore(dataDir, pino({ level: "silent" }));
      await store.init();

      const bound = await store.bindOwnerIdentity({
        channelId: "qqbot",
        externalId: "10001"
      });

      assert.equal(bound.internalUserId, "owner");
      assert.equal(
        await store.findInternalUserId({
          channelId: "qqbot",
          externalId: "10001"
        }),
        "owner"
      );
      assert.deepEqual(await store.list(), [{
        channelId: "qqbot",
        scope: "private_user",
        externalId: "10001",
        internalUserId: "owner",
        createdAt: bound.createdAt
      }]);
      await assert.rejects(access(join(dataDir, "user-identities.json")), /ENOENT/u);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("identity store creates opaque ids for unknown users and reuses existing bindings", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-user-identities-generated-"));
    try {
      const store = new UserIdentityStore(dataDir, pino({ level: "silent" }));
      await store.init();

      const first = await store.ensureUserIdentity({
        channelId: "qqbot",
        externalId: "20002"
      });
      const second = await store.ensureUserIdentity({
        channelId: "qqbot",
        externalId: "20002"
      });

      assert.match(first.internalUserId, /^u_[0-9A-HJKMNP-TV-Z]{26}$/);
      assert.equal(second.internalUserId, first.internalUserId);
      assert.deepEqual(await store.list(), [first]);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("identity store rejects external conflicts and allows explicitly linked connections", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-user-identities-conflict-"));
    try {
      const store = new UserIdentityStore(dataDir, pino({ level: "silent" }));
      await store.init();

      const existing = await store.ensureUserIdentity({
        channelId: "qqbot",
        externalId: "30003"
      });

      await assert.rejects(
        () => store.bindOwnerIdentity({
          channelId: "qqbot",
          externalId: "30003"
        }),
        /already bound/i
      );

      await store.bindIdentity({ channelId: "altbot", externalId: "90009", internalUserId: existing.internalUserId });
      assert.equal((await store.findIdentityByInternalUserId(existing.internalUserId, { channelId: "altbot" }))?.externalId, "90009");
      assert.equal((await store.findIdentityByInternalUserId(existing.internalUserId, { channelId: "qqbot" }))?.externalId, "30003");
      assert.equal(await store.findIdentityByInternalUserId(existing.internalUserId, { channelId: "unrelated" }), undefined);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });


test("identity v1 migrates existing owner without losing it and permits a second connection", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-user-identities-migration-"));
  const logger = pino({ level: "silent" });
  try {
    const old = await new SqliteService(logger).openDatabase({
      databaseId: "state", dbPath: join(dataDir, "state", "state.sqlite"),
      tableGroups: [{ groupId: "state.user_identities", schemaVersion: 1, resetPolicy: "block_reset",
        ownedTables: ["user_identities"], createSchema(db) {
          db.exec(`CREATE TABLE user_identities (
            channel_id TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('private_user')),
            external_id TEXT NOT NULL, internal_user_id TEXT NOT NULL UNIQUE, created_at_ms INTEGER NOT NULL,
            PRIMARY KEY(channel_id, scope, external_id))`);
        }, validateSchema(db) { db.prepare("SELECT channel_id,scope,external_id,internal_user_id,created_at_ms FROM user_identities").all(); }
      }]
    });
    old.db.prepare("INSERT INTO user_identities VALUES (?, ?, ?, ?, ?)").run("napcat", "private_user", "12345", "owner", 42);
    old.close();
    const store = new UserIdentityStore(dataDir, logger);
    await store.init();
    assert.deepEqual(await store.findIdentityByInternalUserId("owner", { channelId: "napcat" }), {
      channelId: "napcat", scope: "private_user", externalId: "12345", internalUserId: "owner", createdAt: 42
    });
    await store.bindOwnerIdentity({ channelId: "qq_official.app", externalId: "opaque-c2c" });
    assert.equal((await store.list()).length, 2);
    assert.equal((await store.findIdentityByInternalUserId("owner", { channelId: "qq_official.app" }))?.externalId, "opaque-c2c");
    assert.equal((await store.findIdentityByInternalUserId("owner", { channelId: "napcat" }))?.externalId, "12345");
    const member = await store.ensureUserIdentity({ channelId: "qq_official.app.group.group1", scope: "group_member", externalId: "opaque-member" });
    assert.notEqual(member.internalUserId, "owner");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
