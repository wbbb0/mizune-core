import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StateDatabase } from "../../src/data/state/stateDatabase.ts";
import { RuntimeResourceRegistry } from "../../src/runtime/resources/runtimeResourceRegistry.ts";
import { RuntimeResourceStore } from "../../src/runtime/resources/runtimeResourceStore.ts";
import {
  MinecraftActorControlStore,
  MinecraftActorIdempotencyConflictError,
  MinecraftActorRevisionConflictError
} from "../../src/services/minecraft/actorControlStore.ts";
import { createSilentLogger } from "../helpers/browser-test-support.tsx";

test("Actor mailbox 持久保存主人请求、FIFO 领取并原子完成 cognition", async () => {
  const fixture = await createFixture();
  try {
    const first = await fixture.control.enqueueRequest({
      resourceId: fixture.resourceId,
      idempotencyKey: "owner-1",
      ownerPrincipalId: "owner",
      ownerSessionId: "web:owner",
      instruction: "先去出生点",
      nowMs: 10,
      expectedRevision: 0
    });
    const second = await fixture.control.enqueueRequest({
      resourceId: fixture.resourceId,
      idempotencyKey: "owner-2",
      ownerPrincipalId: "owner",
      ownerSessionId: "web:owner",
      instruction: "然后收集木头",
      nowMs: 11,
      expectedRevision: 1
    });

    assert.equal(first.request.status, "queued");
    assert.equal(second.state.revision, 2);
    const claimed = await fixture.control.claimNextWake(fixture.resourceId, 12);
    assert.ok(claimed);
    assert.equal(claimed.request?.requestId, first.request.requestId);
    assert.equal(claimed.state.loopPhase, "deciding");

    await fixture.control.completeDecision({
      resourceId: fixture.resourceId,
      wakeId: claimed.wake.wakeId,
      decisionId: claimed.decision.decisionId,
      status: "completed",
      summary: "已经到达出生点",
      persistentState: "位于出生点",
      currentGoal: "收集木头",
      nowMs: 20
    });

    const requests = await fixture.control.listRequests(fixture.resourceId);
    const completed = requests.find(item => item.requestId === first.request.requestId);
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.resultSummary, "已经到达出生点");
    const resource = await fixture.registry.get(fixture.resourceId);
    assert.equal(resource?.minecraftActor?.persistentState, "位于出生点");
    assert.equal(resource?.minecraftActor?.currentGoal, "收集木头");

    const next = await fixture.control.claimNextWake(fixture.resourceId, 21);
    assert.equal(next?.request?.requestId, second.request.requestId);
    const events = await fixture.control.listEvents(fixture.resourceId);
    assert.deepEqual(events.map(event => event.eventType), [
      "owner_request_queued",
      "owner_request_queued",
      "decision_started",
      "decision_completed",
      "decision_started"
    ]);
    assert.ok(events.every((event, index) => index === 0 || event.eventId > events[index - 1]!.eventId));
  } finally {
    await fixture.dispose();
  }
});

test("Actor 请求幂等重放不重复入队，参数冲突和 stale revision 明确失败", async () => {
  const fixture = await createFixture();
  try {
    const input = {
      resourceId: fixture.resourceId,
      idempotencyKey: "same-key",
      ownerPrincipalId: "owner",
      ownerSessionId: "web:owner",
      instruction: "探索附近",
      nowMs: 10,
      expectedRevision: 0
    } as const;
    const created = await fixture.control.enqueueRequest(input);
    const replayed = await fixture.control.enqueueRequest({ ...input, nowMs: 99, expectedRevision: 999 });
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.request.requestId, created.request.requestId);
    assert.equal((await fixture.control.listRequests(fixture.resourceId)).length, 1);

    await assert.rejects(
      fixture.control.enqueueRequest({ ...input, instruction: "攻击玩家", nowMs: 100 }),
      MinecraftActorIdempotencyConflictError
    );
    await assert.rejects(
      fixture.control.enqueueRequest({ ...input, idempotencyKey: "new-key", expectedRevision: 0, nowMs: 101 }),
      MinecraftActorRevisionConflictError
    );
  } finally {
    await fixture.dispose();
  }
});

test("父进程重启会复用相同 decisionId 恢复 running mailbox", async () => {
  const fixture = await createFixture();
  try {
    await fixture.control.enqueueRequest({
      resourceId: fixture.resourceId,
      idempotencyKey: "recover-key",
      ownerPrincipalId: "owner",
      ownerSessionId: "web:owner",
      instruction: "前往矿洞",
      nowMs: 10
    });
    const firstClaim = await fixture.control.claimNextWake(fixture.resourceId, 11);
    assert.ok(firstClaim);
    fixture.database.close();

    const reopenedDatabase = new StateDatabase(fixture.dataDir, createSilentLogger());
    const reopened = new MinecraftActorControlStore(reopenedDatabase);
    assert.equal(await reopened.recoverInterruptedDecisions(20), 1);
    const secondClaim = await reopened.claimNextWake(fixture.resourceId, 21);
    assert.ok(secondClaim);
    assert.equal(secondClaim.decision.decisionId, firstClaim.decision.decisionId);
    assert.equal(secondClaim.decision.attemptCount, 2);
    reopenedDatabase.close();
  } finally {
    await fixture.dispose();
  }
});

test("Actor 资源与 control state 原子创建，启动恢复会修复历史半状态", async () => {
  const fixture = await createFixture();
  try {
    fixture.database.getDb().prepare(
      "DELETE FROM minecraft_actor_control_state WHERE resource_id = ?"
    ).run(fixture.resourceId);
    assert.equal(await fixture.control.getControlState(fixture.resourceId), null);
    assert.equal(await fixture.control.recoverInterruptedDecisions(30), 0);
    const repaired = await fixture.control.getControlState(fixture.resourceId);
    assert.equal(repaired?.ownerPrincipalId, "web:owner");

    await fixture.control.initializeActor({
      resourceId: fixture.resourceId,
      ownerPrincipalId: "owner",
      ownerSessionId: "web:owner",
      nowMs: 31
    });
    assert.equal((await fixture.control.getControlState(fixture.resourceId))?.ownerPrincipalId, "owner");

    await assert.rejects(
      fixture.registry.createMinecraftActor({
        ownerSessionId: "web:owner",
        ownerPrincipalId: " ",
        title: "invalid",
        summary: "invalid",
        createdAtMs: 40,
        expiresAtMs: null,
        minecraftActor: {
          actorId: "invalid",
          transportKind: "in_process",
          endpoint: "simulation:invalid",
          protocolVersion: 1,
          persistentState: "",
          currentGoal: null,
          modelRefs: ["test"],
          allowAutonomyPolicyChange: false,
          allowProgramDeployment: false,
          lastEventSequence: 0
        }
      }),
      /minecraftOwnerPrincipalId/u
    );
    assert.equal((await fixture.registry.list("minecraft_actor")).length, 1);
  } finally {
    await fixture.dispose();
  }
});

test("同毫秒 owner 请求按插入顺序领取，未来 retry 保持 queued revision", async () => {
  const fixture = await createFixture();
  try {
    const first = await fixture.control.enqueueRequest({
      resourceId: fixture.resourceId,
      idempotencyKey: "fifo-1",
      requestId: "request-z",
      ownerPrincipalId: "owner",
      ownerSessionId: "web:owner",
      instruction: "第一件事",
      nowMs: 100
    });
    await fixture.control.enqueueRequest({
      resourceId: fixture.resourceId,
      idempotencyKey: "fifo-2",
      requestId: "request-a",
      ownerPrincipalId: "owner",
      ownerSessionId: "web:owner",
      instruction: "第二件事",
      nowMs: 100
    });
    assert.equal((await fixture.control.claimNextWake(fixture.resourceId, 100))?.request?.requestId, first.request.requestId);
    const firstClaimed = await fixture.control.getControlState(fixture.resourceId);
    assert.ok(firstClaimed?.activeWakeId && firstClaimed.activeDecisionId);
    await fixture.control.completeDecision({
      resourceId: fixture.resourceId,
      wakeId: firstClaimed.activeWakeId,
      decisionId: firstClaimed.activeDecisionId,
      status: "completed",
      summary: "第一件事完成",
      persistentState: "继续",
      nowMs: 101
    });
    const second = await fixture.control.claimNextWake(fixture.resourceId, 102);
    assert.equal(second?.request?.requestId, "request-a");
    assert.ok(second);
    await fixture.control.completeDecision({
      resourceId: fixture.resourceId,
      wakeId: second.wake.wakeId,
      decisionId: second.decision.decisionId,
      status: "failed",
      error: "稍后重试",
      retryAtMs: 1_000,
      nowMs: 103
    });
    const queued = await fixture.control.getControlState(fixture.resourceId);
    assert.equal(queued?.loopPhase, "queued");
    const revision = queued?.revision;
    assert.equal(await fixture.control.claimNextWake(fixture.resourceId, 500), null);
    assert.equal((await fixture.control.getControlState(fixture.resourceId))?.revision, revision);
  } finally {
    await fixture.dispose();
  }
});

test("runtime wake 幂等参数漂移会冲突，journal listener 不能反转已提交事务", async () => {
  const fixture = await createFixture();
  try {
    fixture.control.subscribe(() => { throw new Error("projection failed"); });
    await fixture.control.enqueueWake({
      resourceId: fixture.resourceId,
      wakeId: "runtime-1",
      sourceType: "runtime_event",
      sourceId: "event-1",
      priority: "high",
      wakeType: "danger",
      summary: "附近有危险",
      details: { kind: "zombie" },
      nowMs: 100
    });
    assert.equal((await fixture.control.listEvents(fixture.resourceId)).length, 1);
    await assert.rejects(
      fixture.control.enqueueWake({
        resourceId: fixture.resourceId,
        wakeId: "runtime-1",
        sourceType: "runtime_event",
        sourceId: "event-1",
        priority: "critical",
        wakeType: "danger",
        summary: "参数已变化",
        nowMs: 101
      }),
      MinecraftActorIdempotencyConflictError
    );
  } finally {
    await fixture.dispose();
  }
});

test("永久 close 原子取消 durable mailbox，恢复不会重新打开 closed Actor", async () => {
  const fixture = await createFixture();
  try {
    const queued = await fixture.control.enqueueRequest({
      resourceId: fixture.resourceId,
      idempotencyKey: "close-request",
      ownerPrincipalId: "owner",
      ownerSessionId: "web:owner",
      instruction: "不会继续执行",
      nowMs: 100
    });
    const claimed = await fixture.control.claimNextWake(fixture.resourceId, 101);
    assert.ok(claimed);
    await fixture.control.closeActor(fixture.resourceId, "owner_closed", 102);
    assert.equal((await fixture.control.getControlState(fixture.resourceId))?.loopPhase, "closed");
    assert.equal((await fixture.control.getRequest(fixture.resourceId, queued.request.requestId))?.status, "cancelled");
    assert.equal((await fixture.registry.get(fixture.resourceId))?.status, "closed");
    assert.equal(await fixture.control.recoverInterruptedDecisions(103), 0);
    assert.equal((await fixture.control.getControlState(fixture.resourceId))?.loopPhase, "closed");
  } finally {
    await fixture.dispose();
  }
});

async function createFixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-minecraft-control-store-"));
  const database = new StateDatabase(dataDir, createSilentLogger());
  const registry = new RuntimeResourceRegistry(new RuntimeResourceStore(database));
  const resource = await registry.createMinecraftActor({
    ownerSessionId: "web:owner",
    ownerPrincipalId: "owner",
    title: "Mizune",
    summary: "待命",
    createdAtMs: 1,
    expiresAtMs: null,
    minecraftActor: {
      actorId: "actor-dev",
      transportKind: "in_process",
      endpoint: "simulation:actor-dev",
      protocolVersion: 1,
      persistentState: "待命",
      currentGoal: null,
      modelRefs: ["test"],
      allowAutonomyPolicyChange: true,
      allowProgramDeployment: false,
      lastEventSequence: 0
    }
  });
  const control = new MinecraftActorControlStore(database);
  await control.initializeActor({
    resourceId: resource.resourceId,
    ownerPrincipalId: "owner",
    ownerSessionId: "web:owner",
    nowMs: 2
  });
  return {
    dataDir,
    database,
    registry,
    control,
    resourceId: resource.resourceId,
    async dispose() {
      database.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  };
}
