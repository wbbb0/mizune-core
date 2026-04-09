import assert from "node:assert/strict";
import pino from "pino";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { createInternalTriggerDispatcher } from "../../src/app/session-work/internalTriggerDispatcher.ts";
import { createGenerationSessionOrchestrator } from "../../src/app/generation/generationSessionOrchestrator.ts";

async function runCase(name: string, fn: () => Promise<void>) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

async function main() {
  await runCase("internal trigger dispatcher records received and queued transcript events", async () => {
    const config = createTestAppConfig();
    const sessionManager = new SessionManager(config);
    const sessionId = "private:owner";
    sessionManager.ensureSession({ id: sessionId, type: "private" });
    sessionManager.appendSyntheticPendingMessage(sessionId, {
      chatType: "private",
      userId: "owner",
      senderName: "Owner",
      text: "busy",
      images: []
    });
    const persistedReasons: string[] = [];

    const dispatcher = createInternalTriggerDispatcher({
      logger: pino({ level: "silent" }),
      sessionManager,
      userStore: {
        async getByUserId() {
          return { nickname: "Owner" };
        }
      } as never,
      persistSession(_sessionId: string, reason: string) {
        persistedReasons.push(reason);
      }
    }, {
      async runInternalTriggerSession() {
        throw new Error("should not run immediately while session is busy");
      }
    });

    const dispatchPromise = dispatcher.dispatchTrigger({
      sessionId,
      queueLogEvent: "internal_trigger_queued",
      createTrigger(target) {
        return {
          kind: "scheduled_instruction",
          targetType: target.type,
          targetUserId: target.userId,
          targetSenderName: target.senderName,
          jobName: "daily_reminder",
          instruction: "提醒喝水",
          enqueuedAt: 1
        };
      }
    });

    await Promise.resolve();
    const session = sessionManager.getSession(sessionId);
    const received = session.internalTranscript.find((item) => item.kind === "internal_trigger_event" && item.stage === "received");
    const queued = session.internalTranscript.find((item) => item.kind === "internal_trigger_event" && item.stage === "queued");
    assert.ok(received);
    assert.ok(queued);
    assert.equal(session.pendingInternalTriggers.length, 1);
    assert.ok(persistedReasons.includes("internal_trigger_received"));
    assert.ok(persistedReasons.includes("internal_trigger_queued"));

    session.pendingMessages = [];
    const queuedTrigger = sessionManager.shiftInternalTrigger(sessionId);
    queuedTrigger?.resolveCompletion?.();
    await dispatchPromise;
  });

  await runCase("internal trigger session records started transcript event", async () => {
    const config = createTestAppConfig();
    const sessionManager = new SessionManager(config);
    const sessionId = "private:owner";
    sessionManager.ensureSession({ id: sessionId, type: "private" });
    const persistedReasons: string[] = [];

    const orchestrator = createGenerationSessionOrchestrator({
      config,
      logger: pino({ level: "silent" }),
      sessionManager,
      historyCompressor: {
        async maybeCompress() {
          return false;
        }
      } as never,
      userStore: {
        async getByUserId() {
          return null;
        }
      } as never,
      personaStore: {
        async get() {
          return null;
        }
      } as never,
      setupStore: {} as never,
      persistSession(_sessionId: string, reason: string) {
        persistedReasons.push(reason);
      }
    } as never, {
      promptBuilder: {
        async buildScheduledPromptMessages() {
          return {
            promptMessages: [],
            debugSnapshot: {} as never
          };
        }
      } as never,
      async runGeneration() {
        return;
      },
      processNextSessionWork() {
        return;
      }
    });

    await orchestrator.runInternalTriggerSession(sessionId, {
      kind: "comfy_task_failed",
      targetType: "private",
      targetUserId: "owner",
      targetSenderName: "Owner",
      jobName: "render_retry",
      instruction: "继续重试",
      enqueuedAt: 1,
      taskId: "task-1",
      templateId: "tpl-1",
      positivePrompt: "prompt",
      aspectRatio: "1:1",
      resolvedWidth: 1024,
      resolvedHeight: 1024,
      comfyPromptId: "prompt-1",
      lastError: "GPU OOM",
      autoIterationIndex: 0,
      maxAutoIterations: 3
    });

    const session = sessionManager.getSession(sessionId);
    const started = session.internalTranscript.find((item) => item.kind === "internal_trigger_event" && item.stage === "started");
    assert.ok(started);
    if (started?.kind !== "internal_trigger_event") {
      throw new Error("expected internal_trigger_event");
    }
    assert.equal(started.triggerKind, "comfy_task_failed");
    assert.match(started.details ?? "", /GPU OOM/);
    assert.ok(persistedReasons.includes("internal_trigger_started"));
  });

  await runCase("scheduled instruction resets reply delivery to the session source", async () => {
    const config = createTestAppConfig();
    const sessionManager = new SessionManager(config);
    const sessionId = "web:test";
    sessionManager.ensureSession({ id: sessionId, type: "private", source: "web" });
    sessionManager.setReplyDelivery(sessionId, "onebot");
    const deliveries: Array<"onebot" | "web"> = [];

    const orchestrator = createGenerationSessionOrchestrator({
      config,
      logger: pino({ level: "silent" }),
      sessionManager,
      historyCompressor: {
        async maybeCompress() {
          return false;
        }
      } as never,
      userStore: {
        async getByUserId() {
          return null;
        }
      } as never,
      personaStore: {
        async get() {
          return null;
        }
      } as never,
      setupStore: {} as never,
      persistSession() {}
    } as never, {
      promptBuilder: {
        async buildScheduledPromptMessages() {
          return {
            promptMessages: [],
            debugSnapshot: {} as never
          };
        }
      } as never,
      async runGeneration(input) {
        deliveries.push(input.sendTarget.delivery);
      },
      processNextSessionWork() {}
    });

    await orchestrator.runInternalTriggerSession(sessionId, {
      kind: "scheduled_instruction",
      targetType: "private",
      targetUserId: "owner",
      targetSenderName: "Owner",
      jobName: "daily",
      instruction: "提醒喝水",
      enqueuedAt: 1
    });

    assert.deepEqual(deliveries, ["web"]);
    assert.equal(sessionManager.getReplyDelivery(sessionId), "web");
  });

  await runCase("non-scheduled internal triggers keep the current reply delivery", async () => {
    const config = createTestAppConfig();
    const sessionManager = new SessionManager(config);
    const sessionId = "private:owner";
    sessionManager.ensureSession({ id: sessionId, type: "private" });
    sessionManager.setReplyDelivery(sessionId, "web");
    const deliveries: Array<"onebot" | "web"> = [];

    const orchestrator = createGenerationSessionOrchestrator({
      config,
      logger: pino({ level: "silent" }),
      sessionManager,
      historyCompressor: {
        async maybeCompress() {
          return false;
        }
      } as never,
      userStore: {
        async getByUserId() {
          return null;
        }
      } as never,
      personaStore: {
        async get() {
          return null;
        }
      } as never,
      setupStore: {} as never,
      persistSession() {}
    } as never, {
      promptBuilder: {
        async buildScheduledPromptMessages() {
          return {
            promptMessages: [],
            debugSnapshot: {} as never
          };
        }
      } as never,
      async runGeneration(input) {
        deliveries.push(input.sendTarget.delivery);
      },
      processNextSessionWork() {}
    });

    await orchestrator.runInternalTriggerSession(sessionId, {
      kind: "comfy_task_completed",
      targetType: "private",
      targetUserId: "owner",
      targetSenderName: "Owner",
      jobName: "render_done",
      instruction: "发图",
      enqueuedAt: 1,
      taskId: "task-1",
      templateId: "tpl-1",
      positivePrompt: "prompt",
      aspectRatio: "1:1",
      resolvedWidth: 1024,
      resolvedHeight: 1024,
      workspaceFileIds: ["file-1"],
      workspacePaths: ["workspace/media/file-1.png"],
      comfyPromptId: "prompt-1",
      autoIterationIndex: 0,
      maxAutoIterations: 1
    });

    assert.deepEqual(deliveries, ["web"]);
    assert.equal(sessionManager.getReplyDelivery(sessionId), "web");
  });

  await runCase("flush session prepare failure clears active response state", async () => {
    const config = createTestAppConfig();
    const sessionManager = new SessionManager(config);
    const sessionId = "private:owner";
    sessionManager.ensureSession({ id: sessionId, type: "private" });
    sessionManager.appendSyntheticPendingMessage(sessionId, {
      chatType: "private",
      userId: "owner",
      senderName: "Owner",
      text: "你好",
      images: []
    });
    const persistedReasons: string[] = [];
    let processNextCalled = 0;

    const orchestrator = createGenerationSessionOrchestrator({
      config,
      logger: pino({ level: "silent" }),
      sessionManager,
      historyCompressor: {
        async maybeCompress() {
          throw new Error("compress failed");
        }
      } as never,
      userStore: {
        async getByUserId() {
          return null;
        }
      } as never,
      personaStore: {
        async get() {
          return null;
        }
      } as never,
      setupStore: {
        async get() {
          return { state: "ready" };
        }
      } as never,
      turnPlanner: {} as never,
      llmClient: {} as never,
      debounceManager: {} as never,
      persistSession(_sessionId: string, reason: string) {
        persistedReasons.push(reason);
      }
    } as never, {
      promptBuilder: {
        async buildChatPromptMessages() {
          return {
            promptMessages: [],
            debugSnapshot: {} as never
          };
        }
      } as never,
      async runGeneration() {},
      processNextSessionWork() {
        processNextCalled += 1;
      }
    });

    orchestrator.flushSession(sessionId);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(sessionManager.hasActiveResponse(sessionId), false);
    assert.equal(processNextCalled, 1);
    assert.ok(persistedReasons.includes("generation_finished"));
  });

  await runCase("scheduled trigger prepare failure clears active response state", async () => {
    const config = createTestAppConfig();
    const sessionManager = new SessionManager(config);
    const sessionId = "private:owner";
    sessionManager.ensureSession({ id: sessionId, type: "private" });
    const persistedReasons: string[] = [];
    let processNextCalled = 0;

    const orchestrator = createGenerationSessionOrchestrator({
      config,
      logger: pino({ level: "silent" }),
      sessionManager,
      historyCompressor: {
        async maybeCompress() {
          return false;
        }
      } as never,
      userStore: {
        async getByUserId() {
          return null;
        }
      } as never,
      personaStore: {
        async get() {
          return null;
        }
      } as never,
      setupStore: {} as never,
      persistSession(_sessionId: string, reason: string) {
        persistedReasons.push(reason);
      }
    } as never, {
      promptBuilder: {
        async buildScheduledPromptMessages() {
          throw new Error("prompt failed");
        }
      } as never,
      async runGeneration() {},
      processNextSessionWork() {
        processNextCalled += 1;
      }
    });

    await assert.rejects(
      () => orchestrator.runInternalTriggerSession(sessionId, {
        kind: "scheduled_instruction",
        targetType: "private",
        targetUserId: "owner",
        targetSenderName: "Owner",
        jobName: "daily",
        instruction: "提醒喝水",
        enqueuedAt: 1
      }),
      /prompt failed/
    );

    assert.equal(sessionManager.hasActiveResponse(sessionId), false);
    assert.equal(processNextCalled, 1);
    assert.ok(persistedReasons.includes("generation_finished"));
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
