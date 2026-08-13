import test from "node:test";
import assert from "node:assert/strict";
import { MinecraftActorRuntimeService } from "../../src/services/minecraft/actorRuntimeService.ts";
import type { MinecraftActorResourceManager } from "../../src/services/minecraft/actorResourceManager.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { createSilentLogger } from "../helpers/browser-test-support.tsx";

test("runtime service 隔离单个 Actor 轮询故障并在停止时关闭 manager", async () => {
  const ingested: string[] = [];
  let shutdownCalls = 0;
  const manager = {
    async list() {
      return [
        { resourceId: "actor-failed", status: "active" },
        { resourceId: "actor-healthy", status: "active" },
        { resourceId: "actor-closed", status: "closed" }
      ];
    },
    async ingestEvents(resourceId: string) {
      ingested.push(resourceId);
      if (resourceId === "actor-failed") throw new Error("temporary disconnect");
      return { events: [], wake: null };
    },
    async shutdown() { shutdownCalls += 1; }
  } as unknown as MinecraftActorResourceManager;
  const config = createTestAppConfig({
    minecraft: { enabled: true, eventPollIntervalMs: 100 }
  });
  const service = new MinecraftActorRuntimeService(config, manager, createSilentLogger(), () => 1_000);

  await service.start();
  await service.stop();

  assert.deepEqual(ingested.sort(), ["actor-failed", "actor-healthy"]);
  assert.equal(shutdownCalls, 1);
});

test("禁用 runtime 时 start 不轮询，但 stop 仍释放 manager", async () => {
  let listCalls = 0;
  let shutdownCalls = 0;
  const manager = {
    async list() { listCalls += 1; return []; },
    async shutdown() { shutdownCalls += 1; }
  } as unknown as MinecraftActorResourceManager;
  const service = new MinecraftActorRuntimeService(createTestAppConfig(), manager, createSilentLogger());

  await service.start();
  await service.stop();

  assert.equal(listCalls, 0);
  assert.equal(shutdownCalls, 1);
});
