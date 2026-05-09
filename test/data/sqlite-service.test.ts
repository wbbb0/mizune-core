import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import {
  assertIndexExists,
  assertTableColumns,
  SqliteService,
  type SqliteDatabase,
  type SqliteTableGroupDefinition
} from "../../src/data/sqlite/sqliteService.ts";

function createUserSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
  `);
}

function validateUserSchema(db: SqliteDatabase): void {
  assertTableColumns(db, "users", {
    user_id: "TEXT",
    name: "TEXT"
  });
}

function createCacheSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_cache (
      user_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
    );
  `);
}

function validateCacheSchema(db: SqliteDatabase): void {
  assertTableColumns(db, "user_cache", {
    user_id: "TEXT",
    payload: "TEXT"
  });
}

function createAuditSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_events (
      event_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_events_payload
      ON audit_events(payload);
  `);
}

function validateAuditSchema(db: SqliteDatabase): void {
  assertTableColumns(db, "audit_events", {
    event_id: "TEXT",
    payload: "TEXT"
  });
  assertIndexExists(db, "idx_audit_events_payload");
}

function createGroups(input: {
  usersVersion: number;
  cacheVersion: number;
  auditVersion: number;
}): SqliteTableGroupDefinition[] {
  return [
    {
      groupId: "users",
      schemaVersion: input.usersVersion,
      ownedTables: ["users"],
      createSchema: createUserSchema,
      validateSchema: validateUserSchema
    },
    {
      groupId: "user_cache",
      schemaVersion: input.cacheVersion,
      ownedTables: ["user_cache"],
      dependsOn: ["users"],
      createSchema: createCacheSchema,
      validateSchema: validateCacheSchema
    },
    {
      groupId: "audit",
      schemaVersion: input.auditVersion,
      ownedTables: ["audit_events"],
      ownedIndexes: ["idx_audit_events_payload"],
      createSchema: createAuditSchema,
      validateSchema: validateAuditSchema
    }
  ];
}

async function openHarness(input: {
  dbPath: string;
  usersVersion: number;
  cacheVersion: number;
  auditVersion: number;
}) {
  const service = new SqliteService(pino({ level: "silent" }));
  return service.openDatabase({
    databaseId: "test",
    dbPath: input.dbPath,
    tableGroups: createGroups(input),
    selfHealing: {
      resetDatabaseOnOpenFailure: true,
      resetDatabaseOnIntegrityFailure: true,
      backupInvalidDatabase: true
    }
  });
}

function countRows(db: SqliteDatabase, tableName: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM "${tableName}"`).get() as { count: number }).count;
}

test("SqliteService resets only the changed table group", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-sqlite-service-test-"));
  const dbPath = join(dataDir, "test.sqlite");
  try {
    const first = await openHarness({
      dbPath,
      usersVersion: 1,
      cacheVersion: 1,
      auditVersion: 1
    });
    first.write((db) => {
      db.prepare("INSERT INTO users (user_id, name) VALUES ('u1', '用户一')").run();
      db.prepare("INSERT INTO user_cache (user_id, payload) VALUES ('u1', 'cache-v1')").run();
      db.prepare("INSERT INTO audit_events (event_id, payload) VALUES ('a1', 'audit-v1')").run();
    });
    first.close();

    const second = await openHarness({
      dbPath,
      usersVersion: 1,
      cacheVersion: 2,
      auditVersion: 1
    });
    try {
      assert.equal(countRows(second.db, "users"), 1);
      assert.equal(countRows(second.db, "user_cache"), 0);
      assert.equal(countRows(second.db, "audit_events"), 1);
      const cacheStatus = second.getStatus().tableGroups.find((group) => group.groupId === "user_cache");
      assert.equal(cacheStatus?.actualSchemaVersion, 2);
      assert.equal(cacheStatus?.lastResetReason, "schema_version_mismatch");
    } finally {
      second.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("SqliteService preserves the configured foreign key mode after table group reset", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-sqlite-service-test-"));
  const dbPath = join(dataDir, "test.sqlite");
  try {
    const service = new SqliteService(pino({ level: "silent" }));
    const first = await service.openDatabase({
      databaseId: "test",
      dbPath,
      tableGroups: createGroups({
        usersVersion: 1,
        cacheVersion: 1,
        auditVersion: 1
      }),
      pragmas: {
        foreignKeys: false
      }
    });
    first.close();

    const second = await service.openDatabase({
      databaseId: "test",
      dbPath,
      tableGroups: createGroups({
        usersVersion: 2,
        cacheVersion: 1,
        auditVersion: 1
      }),
      pragmas: {
        foreignKeys: false
      }
    });
    try {
      assert.equal(Number(second.db.pragma("foreign_keys", { simple: true })), 0);
    } finally {
      second.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("SqliteService resets dependent table groups when a parent group changes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-sqlite-service-test-"));
  const dbPath = join(dataDir, "test.sqlite");
  try {
    const first = await openHarness({
      dbPath,
      usersVersion: 1,
      cacheVersion: 1,
      auditVersion: 1
    });
    first.write((db) => {
      db.prepare("INSERT INTO users (user_id, name) VALUES ('u1', '用户一')").run();
      db.prepare("INSERT INTO user_cache (user_id, payload) VALUES ('u1', 'cache-v1')").run();
      db.prepare("INSERT INTO audit_events (event_id, payload) VALUES ('a1', 'audit-v1')").run();
    });
    first.close();

    const second = await openHarness({
      dbPath,
      usersVersion: 2,
      cacheVersion: 1,
      auditVersion: 1
    });
    try {
      assert.equal(countRows(second.db, "users"), 0);
      assert.equal(countRows(second.db, "user_cache"), 0);
      assert.equal(countRows(second.db, "audit_events"), 1);
      const usersStatus = second.getStatus().tableGroups.find((group) => group.groupId === "users");
      const cacheStatus = second.getStatus().tableGroups.find((group) => group.groupId === "user_cache");
      assert.equal(usersStatus?.lastResetReason, "schema_version_mismatch");
      assert.equal(cacheStatus?.lastResetReason, "dependency_reset:users");
    } finally {
      second.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
