import assert from "node:assert/strict";
import test from "node:test";
import {
  ProtocolMinecraftActorClient,
  type MinecraftActorRpcMethod,
  type MinecraftActorTransport
} from "../../src/services/minecraft/actorClient.ts";
import type {
  MinecraftBehaviorCommand,
  MinecraftProgramDocument
} from "../../src/services/minecraft/actorTypes.ts";

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

  close(): void {}
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

test("protocol client supports typed two-phase program deployment", async () => {
  const transport = new RecordingTransport();
  const document = programDocument();
  transport.responses.push({
    protocolVersion: 1,
    ok: true,
    draft: { draftId: "draft-1", validatedAtMs: 10_000, program: document },
    diagnostics: []
  });
  transport.responses.push(commandResult({
    idempotencyKey: "activate-program-1",
    status: "succeeded",
    value: { program: document }
  }));
  const client = new ProtocolMinecraftActorClient("actor-1", transport);

  const validated = await client.validateProgram(document);
  const activated = await client.activateProgram({
    draftId: validated.draft?.draftId ?? "missing",
    expectedActorRevision: 3,
    idempotencyKey: "activate-program-1",
    decisionReason: "部署通过校验的行为程序"
  });

  assert.equal(validated.draft?.draftId, "draft-1");
  assert.equal(activated.ok, true);
  assert.deepEqual(transport.calls.map(call => call.method), ["program.validate", "program.activate"]);
  assert.deepEqual(transport.calls[0]?.payload, {
    protocolVersion: 1,
    actorId: "actor-1",
    document
  });
});

test("protocol client rejects contradictory program validation results", async () => {
  const transport = new RecordingTransport();
  transport.responses.push({ protocolVersion: 1, ok: true, draft: null, diagnostics: [] });
  const client = new ProtocolMinecraftActorClient("actor-1", transport);

  await assert.rejects(client.validateProgram(programDocument()), /contradictory/);
});

test("protocol client rejects mismatched command and program response correlation", async () => {
  const transport = new RecordingTransport();
  transport.responses.push(commandResult({ idempotencyKey: "wrong-key" }));
  transport.responses.push({
    protocolVersion: 1,
    ok: true,
    draft: {
      draftId: "draft-wrong",
      validatedAtMs: 10_000,
      program: { ...programDocument(), programVersion: 2 }
    },
    diagnostics: []
  });
  const client = new ProtocolMinecraftActorClient("actor-1", transport);

  await assert.rejects(client.startBehavior({
    kind: "go_to",
    position: { x: 1, y: 64, z: 1 },
    tolerance: 1,
    expectedActorRevision: 3,
    expectedObservationRevision: 7,
    idempotencyKey: "expected-key",
    decisionReason: "测试响应关联"
  }), /idempotencyKey 不匹配/);
  await assert.rejects(client.validateProgram(programDocument()), /draft 与提交文档不匹配/);
});

test("protocol client rejects oversized and deeply nested runtime responses", async () => {
  const transport = new RecordingTransport();
  transport.responses.push(Array.from({ length: 257 }, (_, index) => runtimeEvent({
    eventId: `event-${index}`,
    sequence: index + 1
  })));
  let nested: Record<string, unknown> = {};
  for (let depth = 0; depth < 25; depth += 1) nested = { next: nested };
  transport.responses.push(observation({ value: nested }));
  const client = new ProtocolMinecraftActorClient("actor-1", transport);

  await assert.rejects(client.listEvents(), /Too big|节点预算|超过/u);
  await assert.rejects(client.observe({ scope: "environment" }), /嵌套深度预算/);
});

test("protocol client rejects duplicate or non-monotonic event pages", async () => {
  const transport = new RecordingTransport();
  transport.responses.push([
    runtimeEvent({ eventId: "event-2", sequence: 2 }),
    runtimeEvent({ eventId: "event-1", sequence: 1 })
  ]);
  transport.responses.push([
    runtimeEvent({ eventId: "same", sequence: 3 }),
    runtimeEvent({ eventId: "same", sequence: 4 })
  ]);
  const client = new ProtocolMinecraftActorClient("actor-1", transport);

  await assert.rejects(client.listEvents(), /sequence 必须严格递增/);
  await assert.rejects(client.listEvents(), /eventId 重复/);
  await assert.rejects(client.listEvents(-1), /afterSequence/);
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

function programDocument(): MinecraftProgramDocument {
  return {
    protocolVersion: 1,
    programId: "idle-item-collector",
    programVersion: 1,
    expectedActorRevision: 3,
    language: "python",
    apiVersion: "mizune.mc.v1",
    entrypoint: "main",
    source: "async def main(ctx):\n    return\n",
    sourceHash: "sha256:" + "a".repeat(64),
    requiredCapabilities: [],
    metadata: { summary: "空闲时收集掉落物" }
  };
}
