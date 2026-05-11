import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
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
  usersResetPolicy?: "reset_allowed" | "block_reset";
  cacheResetPolicy?: "reset_allowed" | "block_reset";
  auditResetPolicy?: "reset_allowed" | "block_reset";
}): SqliteTableGroupDefinition[] {
  return [
    {
      groupId: "users",
      schemaVersion: input.usersVersion,
      ownedTables: ["users"],
      ...(input.usersResetPolicy ? { resetPolicy: input.usersResetPolicy } : {}),
      createSchema: createUserSchema,
      validateSchema: validateUserSchema
    },
    {
      groupId: "user_cache",
      schemaVersion: input.cacheVersion,
      ownedTables: ["user_cache"],
      dependsOn: ["users"],
      ...(input.cacheResetPolicy ? { resetPolicy: input.cacheResetPolicy } : {}),
      createSchema: createCacheSchema,
      validateSchema: validateCacheSchema
    },
    {
      groupId: "audit",
      schemaVersion: input.auditVersion,
      ownedTables: ["audit_events"],
      ownedIndexes: ["idx_audit_events_payload"],
      ...(input.auditResetPolicy ? { resetPolicy: input.auditResetPolicy } : {}),
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
  usersResetPolicy?: "reset_allowed" | "block_reset";
  cacheResetPolicy?: "reset_allowed" | "block_reset";
  auditResetPolicy?: "reset_allowed" | "block_reset";
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

function withRawDatabase<T>(dbPath: string, fn: (db: SqliteDatabase) => T): T {
  const db = new Database(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
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

test("SqliteService allows block_reset table groups to initialize an empty database", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-sqlite-service-test-"));
  const dbPath = join(dataDir, "test.sqlite");
  try {
    const handle = await openHarness({
      dbPath,
      usersVersion: 1,
      cacheVersion: 1,
      auditVersion: 1,
      usersResetPolicy: "block_reset"
    });
    try {
      handle.write((db) => {
        db.prepare("INSERT INTO users (user_id, name) VALUES ('u1', '用户一')").run();
      });
      const usersStatus = handle.getStatus().tableGroups.find((group) => group.groupId === "users");
      assert.equal(usersStatus?.resetPolicy, "block_reset");
      assert.equal(usersStatus?.actualSchemaVersion, 1);
      assert.equal(countRows(handle.db, "users"), 1);
    } finally {
      handle.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("SqliteService blocks version mismatch resets for block_reset table groups", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-sqlite-service-test-"));
  const dbPath = join(dataDir, "test.sqlite");
  try {
    const first = await openHarness({
      dbPath,
      usersVersion: 1,
      cacheVersion: 1,
      auditVersion: 1,
      usersResetPolicy: "block_reset"
    });
    first.write((db) => {
      db.prepare("INSERT INTO users (user_id, name) VALUES ('u1', '用户一')").run();
    });
    first.close();

    await assert.rejects(
      openHarness({
        dbPath,
        usersVersion: 2,
        cacheVersion: 1,
        auditVersion: 1,
        usersResetPolicy: "block_reset"
      }),
      /reset blocked by resetPolicy=block_reset: users\(schema_version_mismatch\)/u
    );

    const reopened = await openHarness({
      dbPath,
      usersVersion: 1,
      cacheVersion: 1,
      auditVersion: 1,
      usersResetPolicy: "block_reset"
    });
    try {
      assert.equal(countRows(reopened.db, "users"), 1);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("SqliteService blocks dependency resets that would drop block_reset table groups", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-sqlite-service-test-"));
  const dbPath = join(dataDir, "test.sqlite");
  try {
    const first = await openHarness({
      dbPath,
      usersVersion: 1,
      cacheVersion: 1,
      auditVersion: 1,
      cacheResetPolicy: "block_reset"
    });
    first.write((db) => {
      db.prepare("INSERT INTO users (user_id, name) VALUES ('u1', '用户一')").run();
      db.prepare("INSERT INTO user_cache (user_id, payload) VALUES ('u1', 'cache-v1')").run();
    });
    first.close();

    await assert.rejects(
      openHarness({
        dbPath,
        usersVersion: 2,
        cacheVersion: 1,
        auditVersion: 1,
        cacheResetPolicy: "block_reset"
      }),
      /reset blocked by resetPolicy=block_reset: user_cache\(dependency_reset:users\)/u
    );

    const reopened = await openHarness({
      dbPath,
      usersVersion: 1,
      cacheVersion: 1,
      auditVersion: 1,
      cacheResetPolicy: "block_reset"
    });
    try {
      assert.equal(countRows(reopened.db, "users"), 1);
      assert.equal(countRows(reopened.db, "user_cache"), 1);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("SqliteService blocks schema validation failure resets for block_reset table groups with metadata", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-sqlite-service-test-"));
  const dbPath = join(dataDir, "test.sqlite");
  try {
    const first = await openHarness({
      dbPath,
      usersVersion: 1,
      cacheVersion: 1,
      auditVersion: 1,
      auditResetPolicy: "block_reset"
    });
    first.write((db) => {
      db.prepare("INSERT INTO audit_events (event_id, payload) VALUES ('a1', 'audit-v1')").run();
    });
    first.close();

    withRawDatabase(dbPath, (db) => {
      db.exec("DROP INDEX idx_audit_events_payload");
    });

    await assert.rejects(
      openHarness({
        dbPath,
        usersVersion: 1,
        cacheVersion: 1,
        auditVersion: 1,
        auditResetPolicy: "block_reset"
      }),
      /reset blocked by resetPolicy=block_reset: audit\(schema_validation_failed\)/u
    );

    withRawDatabase(dbPath, (db) => {
      assert.equal(countRows(db, "audit_events"), 1);
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("SqliteService blocks schema_missing resets for block_reset table groups with existing objects but no metadata", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-sqlite-service-test-"));
  const dbPath = join(dataDir, "test.sqlite");
  try {
    withRawDatabase(dbPath, (db) => {
      db.exec(`
        CREATE TABLE users (
          user_id TEXT PRIMARY KEY
        );
        INSERT INTO users (user_id) VALUES ('u1');
      `);
    });

    await assert.rejects(
      openHarness({
        dbPath,
        usersVersion: 1,
        cacheVersion: 1,
        auditVersion: 1,
        usersResetPolicy: "block_reset"
      }),
      /reset blocked by resetPolicy=block_reset: users\(schema_missing\)/u
    );

    withRawDatabase(dbPath, (db) => {
      assert.equal(countRows(db, "users"), 1);
      const columns = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
      assert.deepEqual(columns.map((column) => column.name), ["user_id"]);
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
