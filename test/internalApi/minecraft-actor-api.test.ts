import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { EventEmitter } from "node:events";
import { StateDatabase } from "../../src/data/state/stateDatabase.ts";
import { RuntimeResourceRegistry } from "../../src/runtime/resources/runtimeResourceRegistry.ts";
import { RuntimeResourceStore } from "../../src/runtime/resources/runtimeResourceStore.ts";
import {
  getMinecraftActorDetail,
  openMinecraftActorStream
} from "../../src/internalApi/application/minecraftActorAdminService.ts";
import { registerMinecraftActorRoutes } from "../../src/internalApi/routes/minecraftActorRoutes.ts";
import { replyWithSseStream, SseConnectionRegistry } from "../../src/internalApi/routes/sse.ts";
import { MinecraftActorControlStore } from "../../src/services/minecraft/actorControlStore.ts";
import type { InternalApiMinecraftActorDeps } from "../../src/internalApi/types.ts";
import { createSilentLogger } from "../helpers/browser-test-support.tsx";

test("Actor read model 不泄露 transport，SSE 支持 snapshot、resume、reset 和 live cursor", async () => {
  const fixture = await createFixture();
  try {
    await fixture.control.enqueueRequest({
      resourceId: fixture.resourceId,
      idempotencyKey: "first",
      ownerPrincipalId: "owner",
      ownerSessionId: "web:owner",
      instruction: "第一件事",
      nowMs: 10
    });
    const detail = await getMinecraftActorDetail(fixture.deps, fixture.resourceId);
    assert.ok(detail);
    assert.equal(detail.runtimeSnapshot?.self.connected, true);
    assert.doesNotMatch(JSON.stringify(detail), /runtime\.sock|modelRefs|ownerPrincipal/u);

    const first = await openMinecraftActorStream(fixture.deps, fixture.resourceId, null);
    assert.equal(first.initialEvents[0]?.type, "actor_snapshot");
    assert.equal(first.initialEvents[0]?.id, 1);
    const live: Array<{ id: number; type: string }> = [];
    const unsubscribe = first.subscribe(event => live.push({ id: event.id, type: event.type }));
    await fixture.control.enqueueRequest({
      resourceId: fixture.resourceId,
      idempotencyKey: "second",
      ownerPrincipalId: "owner",
      ownerSessionId: "web:owner",
      instruction: "第二件事",
      nowMs: 11
    });
    assert.deepEqual(live, [{ id: 2, type: "actor_event" }]);
    unsubscribe();

    const resumed = await openMinecraftActorStream(fixture.deps, fixture.resourceId, 1);
    assert.deepEqual(resumed.initialEvents.map(event => [event.type, event.id]), [
      ["actor_resume", 1],
      ["actor_event", 2]
    ]);
    resumed.subscribe(() => {})();

    const reset = await openMinecraftActorStream(fixture.deps, fixture.resourceId, 999);
    assert.deepEqual(reset.initialEvents.map(event => [event.type, event.id]), [["actor_reset", 2]]);
    reset.subscribe(() => {})();
  } finally {
    await fixture.dispose();
  }
});

test("SSE 构建 snapshot 期间发生的 live event 不会丢失或跑到初始帧前", async () => {
  const fixture = await createFixture();
  try {
    const probeStarted = deferred<void>();
    const releaseProbe = deferred<void>();
    fixture.deps.minecraftActorManager.probe = async () => {
      probeStarted.resolve(undefined);
      await releaseProbe.promise;
      return snapshot();
    };
    const opening = openMinecraftActorStream(fixture.deps, fixture.resourceId, null);
    await probeStarted.promise;
    await fixture.control.enqueueRequest({
      resourceId: fixture.resourceId,
      idempotencyKey: "during-snapshot",
      ownerPrincipalId: "owner",
      ownerSessionId: "web:owner",
      instruction: "快照期间入队",
      nowMs: 20
    });
    releaseProbe.resolve(undefined);
    const stream = await opening;
    assert.equal(stream.initialEvents[0]?.type, "actor_snapshot");
    const live: number[] = [];
    const unsubscribe = stream.subscribe(event => live.push(event.id));
    assert.deepEqual(live, [1]);
    unsubscribe();
  } finally {
    await fixture.dispose();
  }
});

test("SSE 建流期间断开会取消慢 probe 并释放 journal subscription", async () => {
  const fixture = await createFixture();
  try {
    const probeStarted = deferred<void>();
    fixture.deps.minecraftActorManager.probe = async (_resourceId: string, signal?: AbortSignal): Promise<never> => {
      probeStarted.resolve(undefined);
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const listeners = (fixture.control as unknown as { listeners: Set<unknown> }).listeners;
    const controller = new AbortController();
    const opening = openMinecraftActorStream(fixture.deps, fixture.resourceId, null, controller.signal);
    await probeStarted.promise;
    assert.equal(listeners.size, 1);
    controller.abort(new Error("client disconnected"));
    await assert.rejects(opening, { name: "AbortError" });
    assert.equal(listeners.size, 0);
  } finally {
    await fixture.dispose();
  }
});

test("SSE 对已关闭 Actor 发送终止帧，且不会因其他 Actor 的全局 ID 间隙错误 reset", async () => {
  const fixture = await createFixture();
  try {
    await fixture.control.enqueueRequest({
      resourceId: fixture.resourceId,
      idempotencyKey: "before-gap",
      ownerPrincipalId: "owner",
      ownerSessionId: "web:owner",
      instruction: "间隙前",
      nowMs: 30
    });
    const firstEventId = await fixture.control.getLatestEventId(fixture.resourceId);
    const other = await createActorResource(fixture.registry, "other", 31);
    await fixture.database.init();
    const insert = fixture.database.getDb().prepare(`
      INSERT INTO minecraft_actor_events (
        resource_id, event_type, severity, actor_revision, request_id,
        decision_id, payload_json, occurred_at_ms
      ) VALUES (?, 'noise', 'debug', 0, NULL, NULL, '{}', ?)
    `);
    const insertNoise = fixture.database.getDb().transaction(() => {
      for (let index = 0; index < 2_050; index += 1) insert.run(other.resourceId, 32 + index);
    });
    insertNoise();
    await fixture.control.enqueueRequest({
      resourceId: fixture.resourceId,
      idempotencyKey: "after-gap",
      ownerPrincipalId: "owner",
      ownerSessionId: "web:owner",
      instruction: "间隙后",
      nowMs: 3_000
    });
    const resumed = await openMinecraftActorStream(fixture.deps, fixture.resourceId, firstEventId);
    assert.deepEqual(resumed.initialEvents.map(event => event.type), ["actor_resume", "actor_event"]);
    resumed.dispose();

    await fixture.control.closeActor(fixture.resourceId, "connect EINVAL /home/private/runtime.sock", 4_000);
    const closed = await openMinecraftActorStream(fixture.deps, fixture.resourceId, null);
    const terminal: string[] = [];
    const unsubscribeClosed = closed.subscribe(event => terminal.push(event.type));
    assert.equal(closed.initialEvents.at(-1)?.type, "actor_snapshot");
    assert.deepEqual(terminal, ["actor_terminal"]);
    assert.doesNotMatch(JSON.stringify([...closed.initialEvents, terminal]), /\/home\/private|runtime\.sock|connect EINVAL/u);
    unsubscribeClosed();
  } finally {
    await fixture.dispose();
  }
});

test("Actor public detail 不返回 transport probe 原始错误", async () => {
  const fixture = await createFixture();
  try {
    fixture.deps.minecraftActorManager.probe = async () => {
      throw new Error("connect EINVAL /home/private/runtime.sock");
    };
    const detail = await getMinecraftActorDetail(fixture.deps, fixture.resourceId);
    assert.equal(detail?.runtimeError, "Minecraft Runtime 暂时不可用");
    assert.doesNotMatch(JSON.stringify(detail), /\/home\/private|runtime\.sock|connect EINVAL/u);
  } finally {
    await fixture.dispose();
  }
});

test("Actor HTTP mutation 以 202 接收持久请求，并拒绝 stale revision 和跨来源", async () => {
  const fixture = await createFixture();
  const app = Fastify({ logger: false });
  registerMinecraftActorRoutes(app, fixture.deps);
  try {
    const accepted = await app.inject({
      method: "POST",
      url: `/api/minecraft/actors/${fixture.resourceId}/requests`,
      headers: { host: "localhost", origin: "http://localhost", "idempotency-key": "http-1" },
      payload: { instruction: "去出生点", expectedRevision: 0 }
    });
    assert.equal(accepted.statusCode, 202);
    assert.equal(accepted.json().request.status, "queued");

    const stale = await app.inject({
      method: "POST",
      url: `/api/minecraft/actors/${fixture.resourceId}/requests`,
      headers: { host: "localhost", origin: "http://localhost", "idempotency-key": "http-2" },
      payload: { instruction: "再做一件事", expectedRevision: 0 }
    });
    assert.equal(stale.statusCode, 409);

    const crossOrigin = await app.inject({
      method: "POST",
      url: `/api/minecraft/actors/${fixture.resourceId}/requests`,
      headers: { host: "localhost", origin: "https://evil.example", "idempotency-key": "http-3" },
      payload: { instruction: "越权", expectedRevision: 1 }
    });
    assert.equal(crossOrigin.statusCode, 403);

    const missingIdempotency = await app.inject({
      method: "POST",
      url: `/api/minecraft/actors/${fixture.resourceId}/requests`,
      headers: { host: "localhost", origin: "http://localhost" },
      payload: { instruction: "缺幂等键", expectedRevision: 1 }
    });
    assert.equal(missingIdempotency.statusCode, 428);

    const oversizedIdempotency = await app.inject({
      method: "POST",
      url: `/api/minecraft/actors/${fixture.resourceId}/requests`,
      headers: {
        host: "localhost",
        origin: "http://localhost",
        "idempotency-key": "x".repeat(253)
      },
      payload: { instruction: "幂等键过长", expectedRevision: 1 }
    });
    assert.equal(oversizedIdempotency.statusCode, 400);

    await fixture.control.enqueueRequest({
      resourceId: fixture.resourceId,
      idempotencyKey: "advance-before-close",
      ownerPrincipalId: "owner",
      ownerSessionId: "web:owner",
      instruction: "推进 revision",
      nowMs: 101
    });
    const staleClose = await app.inject({
      method: "POST",
      url: `/api/minecraft/actors/${fixture.resourceId}/close`,
      headers: { host: "localhost", origin: "http://localhost" },
      payload: { expectedRevision: 1, reason: "stale close" }
    });
    assert.equal(staleClose.statusCode, 409);
    assert.equal((await fixture.registry.get(fixture.resourceId))?.status, "active");
  } finally {
    await app.close();
    await fixture.dispose();
  }
});

test("SSE helper 总是先写 initial，再写同步 live，并输出 event id", () => {
  const requestRaw = new EventEmitter();
  let output = "";
  let ended = false;
  const replyRaw = Object.assign(new EventEmitter(), {
    destroyed: false,
    writeHead() {},
    write(chunk: string) { output += chunk; return true; },
    end() { ended = true; }
  });
  let cleaned = 0;
  replyWithSseStream(
    { raw: requestRaw } as never,
    { hijack() {}, raw: replyRaw } as never,
    {
      initialEvents: [{ type: "snapshot", id: 1 }],
      subscribe(listener) {
        listener({ type: "live", id: 2 });
        return () => { cleaned += 1; };
      }
    },
    { eventId: event => event.id }
  );
  assert.ok(output.indexOf("event: snapshot") < output.indexOf("event: live"));
  assert.match(output, /id: 1\nevent: snapshot/u);
  assert.match(output, /id: 2\nevent: live/u);
  requestRaw.emit("close");
  assert.equal(cleaned, 1);
  assert.equal(ended, true);
});

test("SSE registry 会在 Fastify 关闭前终止长连接", async () => {
  const app = Fastify({ logger: false });
  const registry = new SseConnectionRegistry();
  app.get("/events", (request, reply) => {
    replyWithSseStream(
      request,
      reply,
      { initialEvents: [{ type: "snapshot" }], subscribe: () => () => {} },
      { connectionRegistry: registry }
    );
  });
  app.addHook("preClose", () => registry.closeAll());
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/events`);
  assert.equal(response.status, 200);
  assert.equal(registry.size, 1);
  await Promise.race([
    app.close(),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("SSE 阻塞 app.close")), 1_000))
  ]);
  assert.equal(registry.size, 0);
});

async function createFixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-minecraft-actor-api-"));
  const database = new StateDatabase(dataDir, createSilentLogger());
  const registry = new RuntimeResourceRegistry(new RuntimeResourceStore(database));
  const control = new MinecraftActorControlStore(database);
  const resource = await createActorResource(registry, "actor-dev", 1);
  const manager = {
    async list() { return registry.list("minecraft_actor"); },
    async get(resourceId: string) { return registry.get(resourceId); },
    async probe() { return snapshot(); },
    async request(resourceId: string, input: Parameters<typeof control.enqueueRequest>[0]) {
      const result = await control.enqueueRequest({ ...input, resourceId, nowMs: 100 });
      return { request: result.request, revision: result.state.revision, replayed: result.replayed };
    },
    async processMailbox() { return null; },
    async interrupt() { return { interrupted: false, revision: 0 }; },
    async close(
      resourceId: string,
      reason: string,
      authorization?: { ownerPrincipalId: string; expectedRevision?: number }
    ) {
      await control.closeActor(resourceId, reason, 200, authorization);
    }
  };
  const deps = {
    minecraftActorManager: manager,
    minecraftActorControlStore: control
  } as unknown as InternalApiMinecraftActorDeps;
  return {
    dataDir,
    database,
    registry,
    control,
    resourceId: resource.resourceId,
    deps,
    async dispose() {
      database.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  };
}

async function createActorResource(
  registry: RuntimeResourceRegistry,
  actorId: string,
  createdAtMs: number
) {
  return registry.createMinecraftActor({
    ownerSessionId: "web:owner",
    ownerPrincipalId: "owner",
    title: "Mizune",
    description: "测试 Actor",
    summary: "待命",
    createdAtMs,
    expiresAtMs: null,
    minecraftActor: {
      actorId,
      transportKind: "unix_socket",
      endpoint: "/private/runtime.sock",
      protocolVersion: 1,
      persistentState: "待命",
      currentGoal: null,
      modelRefs: ["secret-model-ref"],
      allowAutonomyPolicyChange: true,
      allowProgramDeployment: true,
      lastEventSequence: 0
    }
  });
}

function snapshot() {
  return {
    protocolVersion: 1 as const,
    actorId: "actor-dev",
    actorRevision: 1,
    observationRevision: 1,
    self: { position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, connected: true },
    activeBehavior: null,
    actionLease: null,
    activeTask: null,
    queuedTaskCount: 0,
    autonomyPolicy: {
      enabled: false,
      idleDelayMs: 10_000,
      collectItems: true,
      explore: true,
      combatHostiles: false,
      exploreRadius: 16,
      combatStopHealth: 8
    }
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(promiseResolve => { resolve = promiseResolve; });
  return { promise, resolve };
}
