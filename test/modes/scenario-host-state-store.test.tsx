import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import pino from "pino";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { ScenarioHostStateStore } from "../../src/modes/scenarioHost/stateStore.ts";
import {
  createInitialScenarioHostSessionState,
  isScenarioStateInitialized,
  migrateScenarioHostSessionState
} from "../../src/modes/scenarioHost/types.ts";

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
      assert.equal(initial.version, 5);
      assert.deepEqual(initial.profile, {
        theme: "",
        worldBaseline: "",
        narrationStyle: "",
        boundaries: ""
      });
      assert.deepEqual(initial.loreEntries, []);
      assert.deepEqual(initial.npcs, []);
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

  test("scenario_host state store migrates v1 rows to v4 with the legacy global scenario profile", async () => {
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
          inventory: [
            { ownerId: "10001", item: "铜钥匙", quantity: 1 },
            { ownerId: "scene-cache", item: "码头地图", quantity: 1 }
          ],
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
      assert.equal(migrated.version, 5);
      assert.equal(migrated.currentSituation, "旧状态");
      assert.equal(migrated.turnIndex, 4);
      assert.deepEqual(migrated.profile, {
        theme: "悬疑",
        worldBaseline: "旧城雨夜",
        narrationStyle: "克制冷静",
        boundaries: "不写血腥细节"
      });
      assert.deepEqual(migrated.player.heldItems, [{
        name: "铜钥匙",
        description: "由旧版背包条目迁移，缺少更具体描述。",
        quantity: 1
      }]);
      const migratedMap = migrated.entities.find((entity) => entity.name === "码头地图");
      assert.equal(migratedMap?.kind, "item");
      assert.match(migratedMap?.notes ?? "", /ownerId=scene-cache/);
      assert.equal(migrated.loreEntries.length, 0);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("scenario_host state store upgrades v3 schema group rows to v5", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "scenario-host-store-"));
    try {
      const sessionsDir = join(dataDir, "sessions");
      await mkdir(sessionsDir, { recursive: true });
      const dbPath = join(sessionsDir, "sessions.sqlite");
      const db = new Database(dbPath);
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
          VALUES ('sessions.scenario_host_state', 3, ?, '[]', 1, 1)
        `).run(JSON.stringify(["scenario_host_session_states"]));
        db.prepare(`
          INSERT INTO scenario_host_session_states (session_id, state_json, updated_at_ms)
          VALUES (?, ?, 1)
        `).run("qqbot:p:v3", JSON.stringify({
          version: 3,
          profile: {
            theme: "旧港",
            worldBaseline: "旧港钟楼每晚起雾。",
            narrationStyle: "克制推进",
            boundaries: ""
          },
          currentSituation: "旧状态",
          currentLocation: null,
          sceneSummary: "",
          player: { userId: "10001", displayName: "Alice" },
          inventory: [
            { ownerId: "npc-guard", item: "钥匙串", quantity: 1 },
            { ownerId: "scene-cache", item: "钟楼地图", quantity: 1 }
          ],
          objectives: [],
          loreEntries: [],
          entities: [{
            id: "npc-guard",
            kind: "npc",
            name: "守卫",
            summary: "旧钟楼守门人。",
            status: "警惕"
          }, {
            id: "old-bell",
            kind: "location",
            name: "旧钟楼",
            summary: "雾中的旧建筑。"
          }],
          relations: [],
          journal: [],
          mechanics: {},
          flags: {},
          initialized: true,
          turnIndex: 3
        }));
      } finally {
        db.close();
      }

      const store = new ScenarioHostStateStore(dataDir, createTestAppConfig(), pino({ level: "silent" }));
      await store.init();
      const migrated = await store.get("qqbot:p:v3");
      assert.ok(migrated);
      assert.equal(migrated.version, 5);
      assert.equal(migrated.npcs[0]?.id, "npc-guard");
      assert.equal(migrated.npcs[0]?.heldItems[0]?.name, "钥匙串");
      assert.equal(migrated.entities[0]?.id, "old-bell");
      const migratedMap = migrated.entities.find((entity) => entity.name === "钟楼地图");
      assert.equal(migratedMap?.kind, "item");
      assert.match(migratedMap?.notes ?? "", /ownerId=scene-cache/);

      const verifyDb = new Database(dbPath);
      try {
        const meta = verifyDb.prepare(`
          SELECT schema_version AS schemaVersion
          FROM __sqlite_schema_groups
          WHERE group_id = 'sessions.scenario_host_state'
        `).get() as { schemaVersion: number };
        const row = verifyDb.prepare(`
          SELECT state_json AS stateJson
          FROM scenario_host_session_states
          WHERE session_id = 'qqbot:p:v3'
        `).get() as { stateJson: string };
        assert.equal(meta.schemaVersion, 4);
        assert.equal(JSON.parse(row.stateJson).version, 5);
      } finally {
        verifyDb.close();
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("scenario_host migration merges legacy inventory into existing character held items", () => {
    const base = createInitialScenarioHostSessionState({
      playerUserId: "10001",
      playerDisplayName: "Alice"
    });
    const migrated = migrateScenarioHostSessionState({
      ...base,
      version: 4,
      player: {
        ...base.player,
        heldItems: [{
          name: "随身笔记",
          description: "玩家原本已经记录的持有物。",
          quantity: 1
        }]
      },
      npcs: [{
        id: "npc-guard",
        name: "守卫",
        aliases: [],
        basicInfo: "旧城门口的守卫。",
        characterDescription: "沉默、警觉，习惯先观察来人。",
        wornItems: [{
          name: "灰色制服",
          wearPosition: "身体",
          description: "洗得发白但仍然整齐。"
        }],
        heldItems: [{
          name: "短棍",
          description: "已经记录在角色字段中的持有物。",
          quantity: 1
        }],
        statusDescription: "",
        locationId: null,
        tags: [],
        notes: ""
      }],
      inventory: [
        { ownerId: "10001", item: "铜钥匙", quantity: 1 },
        { ownerId: "npc-guard", item: "钥匙串", quantity: 1 },
        { ownerId: "scene-cache", item: "钟楼地图", quantity: 1 }
      ]
    });

    assert.deepEqual(migrated.player.heldItems.map((item) => item.name), ["随身笔记", "铜钥匙"]);
    assert.deepEqual(migrated.npcs[0]?.heldItems.map((item) => item.name), ["短棍", "钥匙串"]);
    const migratedMap = migrated.entities.find((entity) => entity.name === "钟楼地图");
    assert.equal(migratedMap?.kind, "item");
    assert.match(migratedMap?.notes ?? "", /ownerId=scene-cache/);
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
