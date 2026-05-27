import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  createDataDomainSchema,
  createTableGroupsFromDataDomain,
  defineDataDomain,
  defineTable,
  integerColumn,
  jsonColumn,
  listDataModelRows,
  migrateDataDomainSchema,
  textColumn,
  validateDataDomainSchema
} from "../../src/data/model/index.ts";

test("data model creates and validates sqlite schema from table definitions", () => {
  const domain = defineDataDomain({
    database: "sessions",
    tableGroup: "demo.sessions",
    schemaVersion: 7,
    tables: {
      sessions: defineTable({
        table: "sessions",
        primaryKey: ["sessionId"],
        columns: [
          textColumn("sessionId", { storageName: "session_id", notNull: true }),
          textColumn("title", { nullable: true }),
          integerColumn("updatedAtMs", { storageName: "updated_at_ms", notNull: true }),
          integerColumn("transcriptCount", { storage: "computed" })
        ],
        indexes: [{ name: "idx_sessions_updated_at", columns: ["updatedAtMs"] }]
      }),
      transcript_items: defineTable({
        table: "transcript_items",
        primaryKey: ["sessionId", "itemId"],
        columns: [
          textColumn("sessionId", { storageName: "session_id", notNull: true }),
          textColumn("itemId", { storageName: "item_id", notNull: true }),
          integerColumn("itemIndex", { storageName: "item_index", notNull: true }),
          jsonColumn("item", { storageName: "item_json", notNull: true })
        ],
        unique: [["sessionId", "itemIndex"]],
        foreignKeys: [{
          columns: ["sessionId"],
          referencesTable: "sessions",
          referencesColumns: ["session_id"],
          onDelete: "CASCADE"
        }],
        indexes: [{ name: "idx_transcript_items_session_index", columns: ["sessionId", "itemIndex"] }]
      })
    }
  });
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON");
    createDataDomainSchema(db, domain);
    validateDataDomainSchema(db, domain);

    const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string; type: string }>;
    assert.deepEqual(sessionColumns.map((column) => column.name), ["session_id", "title", "updated_at_ms"]);
    assert.equal(sessionColumns.find((column) => column.name === "updated_at_ms")?.type, "INTEGER");

    db.prepare("INSERT INTO sessions (session_id, title, updated_at_ms) VALUES (?, ?, ?)").run("s1", "Session", 1);
    db.prepare("INSERT INTO transcript_items (session_id, item_id, item_index, item_json) VALUES (?, ?, ?, ?)").run("s1", "i1", 0, "{}");
    const table = domain.tables.transcript_items;
    assert.ok(table);
    assert.deepEqual(listDataModelRows(db, table, {
      filters: { sessionId: "s1" }
    }), {
      rows: [{ sessionId: "s1", itemId: "i1", itemIndex: 0, item: {} }],
      total: 1,
      offset: 0,
      limit: 100
    });
    assert.throws(
      () => db.prepare("INSERT INTO transcript_items (session_id, item_id, item_index, item_json) VALUES (?, ?, ?, ?)").run("missing", "i2", 1, "{}"),
      /FOREIGN KEY/u
    );
  } finally {
    db.close();
  }
});

test("data model derives sqlite table group metadata", () => {
  const domain = defineDataDomain({
    database: "sessions",
    tableGroup: "demo.sessions",
    schemaVersion: 3,
    tables: {
      sessions: defineTable({
        table: "sessions",
        primaryKey: ["sessionId"],
        columns: [textColumn("sessionId", { storageName: "session_id" })],
        indexes: [{ name: "idx_sessions_id", columns: ["sessionId"] }]
      })
    }
  });

  const groups = createTableGroupsFromDataDomain(domain);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.groupId, "demo.sessions");
  assert.equal(groups[0]?.schemaVersion, 3);
  assert.equal(groups[0]?.minReadableSchemaVersion, 3);
  assert.deepEqual(groups[0]?.ownedTables, ["sessions"]);
  assert.deepEqual(groups[0]?.ownedIndexes, ["idx_sessions_id"]);
  assert.equal(typeof groups[0]?.migrateSchema, "function");
});

test("data model derives min-readable schema metadata", () => {
  const domain = defineDataDomain({
    database: "sessions",
    tableGroup: "demo.readable_sessions",
    schemaVersion: 4,
    minReadableSchemaVersion: 2,
    tables: {
      sessions: defineTable({
        table: "sessions",
        primaryKey: ["sessionId"],
        columns: [textColumn("sessionId", { storageName: "session_id" })]
      })
    }
  });

  const [group] = createTableGroupsFromDataDomain(domain);
  assert.ok(group);
  assert.equal(group.groupId, "demo.readable_sessions");
  assert.equal(group.schemaVersion, 4);
  assert.equal(group.minReadableSchemaVersion, 2);
  assert.equal(typeof group.migrateSchema, "function");
});

test("data model applies additive sqlite schema migrations", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE sessions (session_id TEXT PRIMARY KEY, title TEXT)");
    db.prepare("INSERT INTO sessions (session_id, title) VALUES (?, ?)").run("s1", "Session");

    const domain = defineDataDomain({
      database: "sessions",
      tableGroup: "demo.sessions",
      schemaVersion: 2,
      tables: {
        sessions: defineTable({
          table: "sessions",
          primaryKey: ["sessionId"],
          columns: [
            textColumn("sessionId", { storageName: "session_id", notNull: true }),
            textColumn("title", { nullable: true }),
            integerColumn("updatedAtMs", { storageName: "updated_at_ms", notNull: true, defaultSql: "0" })
          ],
          indexes: [{ name: "idx_sessions_updated_at", columns: ["updatedAtMs"] }]
        }),
        session_notes: defineTable({
          table: "session_notes",
          primaryKey: ["noteId"],
          columns: [
            textColumn("noteId", { storageName: "note_id", notNull: true }),
            textColumn("sessionId", { storageName: "session_id", notNull: true })
          ]
        })
      }
    });

    assert.equal(migrateDataDomainSchema(db, domain), true);
    validateDataDomainSchema(db, domain);
    assert.equal(migrateDataDomainSchema(db, domain), false);

    const row = db.prepare("SELECT session_id, title, updated_at_ms FROM sessions WHERE session_id = ?").get("s1");
    assert.deepEqual(row, { session_id: "s1", title: "Session", updated_at_ms: 0 });
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_notes'").get());
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_sessions_updated_at'").get());
  } finally {
    db.close();
  }
});
