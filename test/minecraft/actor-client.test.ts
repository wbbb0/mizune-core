import assert from "node:assert/strict";
import test from "node:test";
import {
  ProtocolMinecraftActorClient,
  type MinecraftActorRpcMethod,
  type MinecraftActorTransport
} from "../../src/services/minecraft/actorClient.ts";
import type { MinecraftBehaviorCommand } from "../../src/services/minecraft/actorTypes.ts";

class RecordingTransport implements MinecraftActorTransport {
  readonly calls: Array<{ method: MinecraftActorRpcMethod; payload: Record<string, unknown> }> = [];
  responses: unknown[] = [];

  async call(method: MinecraftActorRpcMethod, payload: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, payload });
    if (this.responses.length === 0) {
      throw new Error("missing test response");
    }
    return this.responses.shift();
  }
}

test("protocol client sends versioned actor-scoped observation requests", async () => {
  const transport = new RecordingTransport();
  transport.responses.push(observation({ value: [] }));
  const client = new ProtocolMinecraftActorClient("actor-1", transport);

  const result = await client.observe({
    scope: "entities",
    kind: "hostile",
    radius: 16,
    limit: 8
  });

  assert.deepEqual(transport.calls, [{
    method: "observation.get",
    payload: {
      protocolVersion: 1,
      actorId: "actor-1",
      request: {
        scope: "entities",
        kind: "hostile",
        radius: 16,
        limit: 8
      }
    }
  }]);
  assert.equal(result.actorRevision, 3);
  assert.deepEqual(result.value, []);
});

test("protocol client preserves revision and idempotency fields for behavior commits", async () => {
  const transport = new RecordingTransport();
  transport.responses.push(commandResult());
  const client = new ProtocolMinecraftActorClient("actor-1", transport);
  const command: MinecraftBehaviorCommand = {
    kind: "combat",
    targetRef: "opaque-target",
    stopHealth: 8,
    expectedActorRevision: 3,
    expectedObservationRevision: 7,
    idempotencyKey: "decision-1",
    decisionReason: "保护自己"
  };

  const result = await client.startBehavior(command);

  assert.equal(result.ok, true);
  assert.deepEqual(transport.calls[0], {
    method: "behavior.start",
    payload: {
      protocolVersion: 1,
      actorId: "actor-1",
      command
    }
  });
});

test("protocol client rejects snapshots and events from a different actor", async () => {
  const transport = new RecordingTransport();
  transport.responses.push(snapshot({ actorId: "actor-other" }));
  transport.responses.push([runtimeEvent({ actorId: "actor-other" })]);
  const client = new ProtocolMinecraftActorClient("actor-1", transport);

  await assert.rejects(client.getSnapshot(), /actorId 不匹配/);
  await assert.rejects(client.listEvents(), /actorId 不匹配/);
});

test("protocol client rejects unsupported versions and contradictory command results", async () => {
  const transport = new RecordingTransport();
  transport.responses.push(snapshot({ protocolVersion: 2 }));
  transport.responses.push(commandResult({
    ok: true,
    status: "failed",
    reason: "contradiction"
  }));
  const client = new ProtocolMinecraftActorClient("actor-1", transport);

  await assert.rejects(client.getSnapshot());
  await assert.rejects(client.cancelBehavior({
    expectedActorRevision: 3,
    idempotencyKey: "cancel-1",
    reason: "停止"
  }), /contradictory/);
});

test("protocol client rejects non-JSON observation values", async () => {
  const transport = new RecordingTransport();
  transport.responses.push(observation({ value: { unsafe: Number.NaN } }));
  const client = new ProtocolMinecraftActorClient("actor-1", transport);

  await assert.rejects(client.observe({ scope: "self" }));
});

function selfState() {
  return {
    position: { x: 0, y: 64, z: 0 },
    health: 20,
    food: 20,
    connected: true
  };
}

function autonomyPolicy() {
  return {
    enabled: false,
    idleDelayMs: 10_000,
    collectItems: true,
    explore: true,
    combatHostiles: false,
    exploreRadius: 12,
    combatStopHealth: 8
  };
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    actorId: "actor-1",
    actorRevision: 3,
    observationRevision: 7,
    self: selfState(),
    activeBehavior: null,
    actionLease: null,
    activeTask: null,
    queuedTaskCount: 0,
    autonomyPolicy: autonomyPolicy(),
    ...overrides
  };
}

function observation(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    actorId: "actor-1",
    actorRevision: 3,
    observationRevision: 7,
    observedAtMs: 10_000,
    self: selfState(),
    value: null,
    ...overrides
  };
}

function commandResult(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    commandId: "command-1",
    idempotencyKey: "decision-1",
    ok: true,
    status: "accepted",
    reason: null,
    retryability: "none",
    actorRevision: 4,
    observationRevision: 7,
    value: {},
    ...overrides
  };
}

function runtimeEvent(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    eventId: "event-1",
    sequence: 1,
    actorId: "actor-1",
    eventType: "behavior_started",
    priority: "normal",
    occurredAtMs: 10_000,
    actorRevision: 4,
    observationRevision: 7,
    payload: {},
    ...overrides
  };
}
