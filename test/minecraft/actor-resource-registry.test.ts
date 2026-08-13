import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StateDatabase } from "../../src/data/state/stateDatabase.ts";
import { SqliteService } from "../../src/data/sqlite/sqliteService.ts";
import { RuntimeResourceRegistry } from "../../src/runtime/resources/runtimeResourceRegistry.ts";
import { RuntimeResourceStore } from "../../src/runtime/resources/runtimeResourceStore.ts";
import { createSilentLogger } from "../helpers/browser-test-support.tsx";

test("Minecraft actor resource persists decision state and survives ephemeral reset", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-minecraft-actor-resource-"));
  const firstDatabase = new StateDatabase(dataDir, createSilentLogger());
  const firstStore = new RuntimeResourceStore(firstDatabase);
  const firstRegistry = new RuntimeResourceRegistry(firstStore);

  try {
    await firstRegistry.createBrowserPage({
      title: "临时页面",
      summary: "临时",
      createdAtMs: 1,
      expiresAtMs: null,
      browserPage: {
        requestedUrl: "https://example.com",
        resolvedUrl: "https://example.com",
        backend: "playwright",
        title: "Example",
        profileId: null
      }
    });
    const created = await firstRegistry.createMinecraftActor({
      ownerSessionId: "onebot:private:owner",
      ownerPrincipalId: "owner",
      title: "Mizune MC",
      description: "离线模拟 Actor",
      summary: "空闲；goal=探索",
      createdAtMs: 2,
      expiresAtMs: null,
      minecraftActor: {
        actorId: "actor-1",
        transportKind: "in_process",
        endpoint: "simulation:actor-1",
        protocolVersion: 1,
        persistentState: "位于出生点",
        currentGoal: "探索",
        modelRefs: ["prod_deepseek.v4_flash"],
        allowAutonomyPolicyChange: true,
        allowProgramDeployment: false,
        lastEventSequence: 7
      }
    });

    await firstRegistry.resetEphemeral();
    firstDatabase.close();

    const reopenedDatabase = new StateDatabase(dataDir, createSilentLogger());
    const reopenedStore = new RuntimeResourceStore(reopenedDatabase);
    const reopenedRegistry = new RuntimeResourceRegistry(reopenedStore);
    const restored = await reopenedStore.getRow(created.resourceId);

    assert.equal((await reopenedRegistry.list()).length, 1);
    assert.equal(restored?.kind, "minecraft_actor");
    assert.equal(restored?.ownerSessionId, "onebot:private:owner");
    assert.deepEqual(restored?.minecraftActor, {
      actorId: "actor-1",
      transportKind: "in_process",
      endpoint: "simulation:actor-1",
      protocolVersion: 1,
      persistentState: "位于出生点",
      currentGoal: "探索",
      modelRefs: ["prod_deepseek.v4_flash"],
      allowAutonomyPolicyChange: true,
      allowProgramDeployment: false,
      lastEventSequence: 7
    });

    const updatedState = { ...restored?.minecraftActor, persistentState: "探索完成", lastEventSequence: 9 };
    assert.ok(restored?.minecraftActor);
    await reopenedRegistry.updateMinecraftActor(created.resourceId, updatedState as NonNullable<typeof restored.minecraftActor>, {
      updatedAtMs: 10,
      summary: "探索完成"
    });
    const rows = await reopenedStore.listMinecraftActorRows();
    assert.equal(rows.total, 1);
    assert.equal(rows.rows[0]?.persistentState, "探索完成");
    assert.equal(rows.rows[0]?.lastEventSequence, 9);
    reopenedDatabase.close();
  } finally {
    firstDatabase.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("runtime resource schema migration preserves v1 browser and shell rows", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-minecraft-resource-migration-"));
  const stateDir = join(dataDir, "state");
  const dbPath = join(stateDir, "state.sqlite");
  const logger = createSilentLogger();
  await mkdir(stateDir, { recursive: true });
  const sqlite = new SqliteService(logger);
  let stage = "create v1 database";

  try {
    const oldDatabase = await sqlite.openDatabase({
      databaseId: "state",
      dbPath,
      tableGroups: [{
        groupId: "state.runtime_resources",
        schemaVersion: 1,
        resetPolicy: "block_reset",
        ownedTables: ["runtime_resources", "runtime_browser_pages", "runtime_shell_sessions"],
        createSchema(db) {
          db.exec(`
            CREATE TABLE runtime_resources (
              resource_id TEXT PRIMARY KEY NOT NULL,
              kind TEXT NOT NULL CHECK (kind IN ('browser_page', 'shell_session')),
              status TEXT NOT NULL,
              owner_session_id TEXT,
              title TEXT,
              description TEXT,
              summary TEXT NOT NULL DEFAULT '',
              created_at_ms INTEGER NOT NULL,
              last_accessed_at_ms INTEGER NOT NULL,
              expires_at_ms INTEGER
            );
            CREATE TABLE runtime_browser_pages (
              resource_id TEXT PRIMARY KEY NOT NULL REFERENCES runtime_resources(resource_id) ON DELETE CASCADE,
              requested_url TEXT NOT NULL,
              resolved_url TEXT NOT NULL,
              backend TEXT NOT NULL,
              title TEXT,
              profile_id TEXT
            );
            CREATE TABLE runtime_shell_sessions (
              resource_id TEXT PRIMARY KEY NOT NULL REFERENCES runtime_resources(resource_id) ON DELETE CASCADE,
              command TEXT NOT NULL,
              cwd TEXT NOT NULL,
              shell TEXT NOT NULL,
              tty INTEGER NOT NULL,
              login INTEGER NOT NULL
            );
          `);
        },
        validateSchema(db) {
          db.prepare("SELECT 1 FROM runtime_resources LIMIT 1").get();
          db.prepare("SELECT 1 FROM runtime_browser_pages LIMIT 1").get();
          db.prepare("SELECT 1 FROM runtime_shell_sessions LIMIT 1").get();
        }
      }]
    });
    oldDatabase.db.prepare(`
      INSERT INTO runtime_resources (
        resource_id, kind, status, owner_session_id, title, description,
        summary, created_at_ms, last_accessed_at_ms, expires_at_ms
      ) VALUES ('res_shell_old', 'shell_session', 'active', NULL, 'old', NULL, '旧会话', 1, 1, NULL)
    `).run();
    stage = "insert v1 shell row";
    oldDatabase.db.prepare(`
      INSERT INTO runtime_shell_sessions (resource_id, command, cwd, shell, tty, login)
      VALUES ('res_shell_old', 'pwd', '/tmp', '/bin/sh', 1, 0)
    `).run();
    oldDatabase.db.prepare(`
      INSERT INTO runtime_resources (
        resource_id, kind, status, owner_session_id, title, description,
        summary, created_at_ms, last_accessed_at_ms, expires_at_ms
      ) VALUES ('res_browser_old', 'browser_page', 'active', NULL, 'old page', NULL, '旧页面', 2, 2, NULL)
    `).run();
    oldDatabase.db.prepare(`
      INSERT INTO runtime_browser_pages (resource_id, requested_url, resolved_url, backend, title, profile_id)
      VALUES ('res_browser_old', 'https://example.com', 'https://example.com/', 'playwright', 'Example', NULL)
    `).run();
    oldDatabase.close();

    stage = "open and migrate v3 database";
    const migratedDatabase = new StateDatabase(dataDir, logger);
    const store = new RuntimeResourceStore(migratedDatabase);
    const restored = await store.getRow("res_shell_old");
    const restoredBrowser = await store.getRow("res_browser_old");

    assert.equal(restored?.summary, "旧会话");
    assert.equal(restored?.shellSession?.command, "pwd");
    assert.equal(restoredBrowser?.summary, "旧页面");
    assert.equal(restoredBrowser?.browserPage?.resolvedUrl, "https://example.com/");
    assert.deepEqual(
      migratedDatabase.getDb().prepare("PRAGMA table_info(runtime_minecraft_actors)").all()
        .map((column: unknown) => (column as { name: string }).name),
      [
        "resource_id",
        "actor_id",
        "transport_kind",
        "endpoint",
        "protocol_version",
        "persistent_state",
        "current_goal",
        "model_refs_json",
        "allow_autonomy_policy_change",
        "allow_program_deployment",
        "last_event_sequence"
      ]
    );
    assert.deepEqual(
      migratedDatabase.getDb().prepare("PRAGMA table_info(runtime_minecraft_actor_outbox)").all()
        .map((column: unknown) => (column as { name: string }).name),
      [
        "resource_id",
        "outbox_id",
        "event_sequence",
        "kind",
        "payload_json",
        "status",
        "attempt_count",
        "last_error",
        "created_at_ms",
        "delivered_at_ms"
      ]
    );
    migratedDatabase.close();
  } catch (error) {
    throw new Error(`${stage}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("runtime resource schema migration from v2 preserves Minecraft actor state", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-minecraft-resource-v2-migration-"));
  const stateDir = join(dataDir, "state");
  const dbPath = join(stateDir, "state.sqlite");
  const logger = createSilentLogger();
  await mkdir(stateDir, { recursive: true });
  const sqlite = new SqliteService(logger);

  try {
    const oldDatabase = await sqlite.openDatabase({
      databaseId: "state",
      dbPath,
      tableGroups: [{
        groupId: "state.runtime_resources",
        schemaVersion: 2,
        resetPolicy: "block_reset",
        ownedTables: ["runtime_resources", "runtime_browser_pages", "runtime_shell_sessions", "runtime_minecraft_actors"],
        createSchema(db) {
          db.exec(`
            CREATE TABLE runtime_resources (
              resource_id TEXT PRIMARY KEY NOT NULL,
              kind TEXT NOT NULL,
              status TEXT NOT NULL,
              owner_session_id TEXT,
              title TEXT,
              description TEXT,
              summary TEXT NOT NULL DEFAULT '',
              created_at_ms INTEGER NOT NULL,
              last_accessed_at_ms INTEGER NOT NULL,
              expires_at_ms INTEGER
            );
            CREATE TABLE runtime_browser_pages (
              resource_id TEXT PRIMARY KEY NOT NULL REFERENCES runtime_resources(resource_id) ON DELETE CASCADE,
              requested_url TEXT NOT NULL,
              resolved_url TEXT NOT NULL,
              backend TEXT NOT NULL,
              title TEXT,
              profile_id TEXT
            );
            CREATE TABLE runtime_shell_sessions (
              resource_id TEXT PRIMARY KEY NOT NULL REFERENCES runtime_resources(resource_id) ON DELETE CASCADE,
              command TEXT NOT NULL,
              cwd TEXT NOT NULL,
              shell TEXT NOT NULL,
              tty INTEGER NOT NULL,
              login INTEGER NOT NULL
            );
            CREATE TABLE runtime_minecraft_actors (
              resource_id TEXT PRIMARY KEY NOT NULL REFERENCES runtime_resources(resource_id) ON DELETE CASCADE,
              actor_id TEXT NOT NULL,
              transport_kind TEXT NOT NULL,
              endpoint TEXT NOT NULL,
              protocol_version INTEGER NOT NULL,
              persistent_state TEXT NOT NULL,
              current_goal TEXT,
              model_refs_json TEXT NOT NULL,
              allow_autonomy_policy_change INTEGER NOT NULL,
              allow_program_deployment INTEGER NOT NULL,
              last_event_sequence INTEGER NOT NULL
            );
          `);
        },
        validateSchema(db) {
          db.prepare("SELECT 1 FROM runtime_minecraft_actors LIMIT 1").get();
        }
      }]
    });
    oldDatabase.db.prepare(`
      INSERT INTO runtime_resources (
        resource_id, kind, status, owner_session_id, title, description,
        summary, created_at_ms, last_accessed_at_ms, expires_at_ms
      ) VALUES ('res_minecraft_old', 'minecraft_actor', 'active', 'onebot:private:owner', NULL, NULL,
                '旧 Actor', 1, 1, NULL)
    `).run();
    oldDatabase.db.prepare(`
      INSERT INTO runtime_minecraft_actors (
        resource_id, actor_id, transport_kind, endpoint, protocol_version,
        persistent_state, current_goal, model_refs_json,
        allow_autonomy_policy_change, allow_program_deployment, last_event_sequence
      ) VALUES ('res_minecraft_old', 'actor-old', 'in_process', 'simulation:old', 1,
                '保留的状态', '继续巡逻', '["prod_deepseek.v4_flash"]', 0, 1, 42)
    `).run();
    oldDatabase.close();

    const migratedDatabase = new StateDatabase(dataDir, logger);
    const store = new RuntimeResourceStore(migratedDatabase);
    const restored = await store.getRow("res_minecraft_old");

    assert.equal(restored?.status, "active");
    assert.equal(restored?.minecraftActor?.persistentState, "保留的状态");
    assert.equal(restored?.minecraftActor?.lastEventSequence, 42);
    assert.deepEqual(await store.listPendingMinecraftActorOutbox("res_minecraft_old"), []);
    assert.equal(
      migratedDatabase.getStatus()?.tableGroups.find(group => group.groupId === "state.runtime_resources")?.actualSchemaVersion,
      4
    );
    migratedDatabase.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
