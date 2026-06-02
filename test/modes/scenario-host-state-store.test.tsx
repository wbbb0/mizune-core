import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import pino from "pino";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { ScenarioHostStateStore } from "../../src/modes/scenarioHost/stateStore.ts";
import { createInitialScenarioHostSessionState, isScenarioStateInitialized } from "../../src/modes/scenarioHost/types.ts";

  test("scenario_host state store initializes and persists per session state", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "scenario-host-store-"));
    try {
      const store = new ScenarioHostStateStore(dataDir, createTestAppConfig(), pino({ level: "silent" }));
      await store.init();
      const initial = await store.ensure("qqbot:p:10001", {
        playerUserId: "10001",
        playerDisplayName: "Alice"
      });
      assert.equal(initial.player.displayName, "Alice");
      assert.equal(initial.version, 3);
      assert.deepEqual(initial.profile, {
        theme: "",
        worldBaseline: "",
        narrationStyle: "",
        boundaries: ""
      });
      assert.deepEqual(initial.loreEntries, []);
      assert.deepEqual(initial.entities, []);
      assert.deepEqual(initial.relations, []);
      assert.deepEqual(initial.journal, []);
      assert.equal(initial.turnIndex, 0);

      await store.update("qqbot:p:10001", (current) => ({
        ...current,
        turnIndex: 2
      }), {
        playerUserId: "10001",
        playerDisplayName: "Alice"
      });

      const reloaded = await store.get("qqbot:p:10001");
      assert.ok(reloaded);
      assert.ok(!("title" in reloaded));
      assert.equal(reloaded?.turnIndex, 2);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("scenario_host state initializes with initialized=false", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "scenario-host-store-"));
    try {
      const store = new ScenarioHostStateStore(dataDir, createTestAppConfig(), pino({ level: "silent" }));
      await store.init();
      const initial = await store.ensure("qqbot:p:10001", {
        playerUserId: "10001",
        playerDisplayName: "Alice"
      });
      assert.equal(initial.initialized, false);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("scenario_host state store migrates v1 rows to v3 with the legacy global scenario profile", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "scenario-host-store-"));
    try {
      const sessionsDir = join(dataDir, "sessions");
      const stateDir = join(dataDir, "state");
      await mkdir(sessionsDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      const stateDb = new Database(join(stateDir, "state.sqlite"));
      try {
        stateDb.exec(`
          CREATE TABLE scenario_profile (
            id TEXT PRIMARY KEY CHECK (id = 'global'),
            theme TEXT NOT NULL DEFAULT '',
            world_baseline TEXT NOT NULL DEFAULT '',
            narration_style TEXT NOT NULL DEFAULT '',
            boundaries TEXT NOT NULL DEFAULT '',
            updated_at_ms INTEGER NOT NULL
          );
        `);
        stateDb.prepare(`
          INSERT INTO scenario_profile (id, theme, world_baseline, narration_style, boundaries, updated_at_ms)
          VALUES ('global', '悬疑', '旧城雨夜', '克制冷静', '不写血腥细节', 1)
        `).run();
      } finally {
        stateDb.close();
      }
      const db = new Database(join(sessionsDir, "sessions.sqlite"));
      try {
        db.exec(`
          CREATE TABLE __sqlite_schema_groups (
            group_id TEXT PRIMARY KEY,
            schema_version INTEGER NOT NULL,
            owned_tables_json TEXT NOT NULL,
            owned_indexes_json TEXT NOT NULL DEFAULT '[]',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            last_reset_at INTEGER,
            last_reset_reason TEXT
          );
          CREATE TABLE scenario_host_session_states (
            session_id TEXT PRIMARY KEY NOT NULL,
            state_json TEXT NOT NULL,
            updated_at_ms INTEGER NOT NULL
          );
        `);
        db.prepare(`
          INSERT INTO __sqlite_schema_groups (
            group_id, schema_version, owned_tables_json, owned_indexes_json, created_at, updated_at
          )
          VALUES ('sessions.scenario_host_state', 1, ?, '[]', 1, 1)
        `).run(JSON.stringify(["scenario_host_session_states"]));
        db.prepare(`
          INSERT INTO scenario_host_session_states (session_id, state_json, updated_at_ms)
          VALUES (?, ?, 1)
        `).run("qqbot:p:v1", JSON.stringify({
          version: 1,
          currentSituation: "旧状态",
          currentLocation: null,
          sceneSummary: "",
          player: { userId: "10001", displayName: "Alice" },
          inventory: [],
          objectives: [],
          worldFacts: [],
          flags: {},
          initialized: true,
          turnIndex: 4
        }));
      } finally {
        db.close();
      }

      const store = new ScenarioHostStateStore(dataDir, createTestAppConfig(), pino({ level: "silent" }));
      await store.init();
      const migrated = await store.get("qqbot:p:v1");
      assert.ok(migrated);
      assert.equal(migrated.version, 3);
      assert.equal(migrated.currentSituation, "旧状态");
      assert.equal(migrated.turnIndex, 4);
      assert.deepEqual(migrated.profile, {
        theme: "悬疑",
        worldBaseline: "旧城雨夜",
        narrationStyle: "克制冷静",
        boundaries: "不写血腥细节"
      });
      assert.equal(migrated.loreEntries.length, 0);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("scenario_host state store persists in sqlite without legacy json output", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "scenario-host-store-"));
    try {
      const store = new ScenarioHostStateStore(dataDir, createTestAppConfig(), pino({ level: "silent" }));
      await store.init();
      await store.ensure("qqbot:p:sqlite", {
        playerUserId: "10001",
        playerDisplayName: "Alice"
      });

      const sessionFiles = await readdir(join(dataDir, "sessions"), { withFileTypes: true });
      assert.equal(sessionFiles.some((entry) => entry.isFile() && entry.name.endsWith(".json")), false);
      assert.equal(sessionFiles.some((entry) => entry.isFile() && entry.name === "sessions.sqlite"), true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("isScenarioStateInitialized returns false for fresh state", async () => {
    const state = createInitialScenarioHostSessionState({ playerUserId: "u1", playerDisplayName: "Alice" });
    assert.equal(isScenarioStateInitialized(state), false);
  });

  test("isScenarioStateInitialized returns true when initialized=true", async () => {
    const state = createInitialScenarioHostSessionState({ playerUserId: "u1", playerDisplayName: "Alice" });
    assert.equal(isScenarioStateInitialized({ ...state, initialized: true }), true);
  });
