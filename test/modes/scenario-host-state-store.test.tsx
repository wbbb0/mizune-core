import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { ScenarioHostStateStore } from "../../src/modes/scenarioHost/stateStore.ts";
import { createInitialScenarioHostSessionState, isScenarioStateInitialized } from "../../src/modes/scenarioHost/types.ts";

async function runCase(name: string, fn: () => Promise<void>) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

async function main() {
  await runCase("scenario_host state store initializes and persists per session state", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "scenario-host-store-"));
    try {
      const store = new ScenarioHostStateStore(dataDir, createTestAppConfig(), pino({ level: "silent" }));
      await store.init();
      const initial = await store.ensure("private:10001", {
        playerUserId: "10001",
        playerDisplayName: "Alice"
      });
      assert.equal(initial.player.displayName, "Alice");
      assert.equal(initial.turnIndex, 0);

      await store.update("private:10001", (current) => ({
        ...current,
        title: "钟楼迷雾",
        turnIndex: 2
      }), {
        playerUserId: "10001",
        playerDisplayName: "Alice"
      });

      const reloaded = await store.get("private:10001");
      assert.equal(reloaded?.title, "钟楼迷雾");
      assert.equal(reloaded?.turnIndex, 2);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  await runCase("scenario_host state initializes with initialized=false", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "scenario-host-store-"));
    try {
      const store = new ScenarioHostStateStore(dataDir, createTestAppConfig(), pino({ level: "silent" }));
      await store.init();
      const initial = await store.ensure("private:10001", {
        playerUserId: "10001",
        playerDisplayName: "Alice"
      });
      assert.equal(initial.initialized, false);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  await runCase("isScenarioStateInitialized returns false for fresh state", async () => {
    const state = createInitialScenarioHostSessionState({ playerUserId: "u1", playerDisplayName: "Alice" });
    assert.equal(isScenarioStateInitialized(state), false);
  });

  await runCase("isScenarioStateInitialized returns true when initialized=true", async () => {
    const state = createInitialScenarioHostSessionState({ playerUserId: "u1", playerDisplayName: "Alice" });
    assert.equal(isScenarioStateInitialized({ ...state, initialized: true }), true);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
