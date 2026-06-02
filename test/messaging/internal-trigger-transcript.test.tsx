import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { createInternalTriggerDispatcher } from "../../src/app/session-work/internalTriggerDispatcher.ts";
import { createGenerationSessionOrchestrator } from "../../src/app/generation/generationSessionOrchestrator.ts";
import { createInternalTriggerEvent } from "../../src/conversation/session/internalTranscriptEvents.ts";
import { renderInlineTriggerBatchMessage } from "../../src/llm/prompt/promptBuilder.ts";
import { createScheduledTaskDispatcher } from "../../src/app/session-work/scheduledTaskDispatcher.ts";
import type { GenerationSessionOrchestratorDeps } from "../../src/app/generation/generationRunnerDeps.ts";
import { createEmptyPersona } from "../../src/persona/personaSchema.ts";
import { createEmptyRpProfile } from "../../src/modes/rpAssistant/profileSchema.ts";
import { findPromptBlock, hasPromptSection, parsePromptBlocks } from "../helpers/prompt-fixtures.tsx";

async function flushMicrotasks(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}

async function waitForCondition(check: () => boolean, rounds = 20): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    if (check()) {
      return;
    }
    await flushMicrotasks();
  }
}

function createOrchestratorDeps(input: {
  config: ReturnType<typeof createTestAppConfig>;
  sessionManager: SessionManager;
  historyCompressor?: unknown;
  userStore?: unknown;
  personaStore?: unknown;
  rpProfileStore?: unknown;
  userIdentityStore?: unknown;
  setupStore?: unknown;
  scenarioHostStateStore?: unknown;
  globalProfileReadinessStore?: unknown;
  turnPlanner?: unknown;
  llmClient?: unknown;
  debounceManager?: unknown;
  shellRuntime?: unknown;
  persistSession?: (sessionId: string, reason: string) => void;
}): GenerationSessionOrchestratorDeps {
  const sharedUserStore = input.userStore ?? ({
    async getByUserId() {
      return null;
    }
  } as never);
  return {
    promptBuilder: {
      config: input.config
    },
    sessionRuntime: {
      logger: pino({ level: "silent" }),
      sessionManager: input.sessionManager,
      historyCompressor: input.historyCompressor ?? ({ async maybeCompress() { return false; } } as never),
      llmClient: input.llmClient ?? ({} as never),
      turnPlanner: input.turnPlanner ?? ({} as never),
      debounceManager: input.debounceManager ?? ({} as never)
    },
    identity: {
      userStore: sharedUserStore,
      personaStore: input.personaStore ?? ({
        async get() {
          return createEmptyPersona();
        }
      } as never),
      rpProfileStore: input.rpProfileStore ?? ({
        async get() {
          return createEmptyRpProfile();
        }
      } as never),
      setupStore: input.setupStore ?? ({} as never),
      scenarioHostStateStore: input.scenarioHostStateStore ?? ({
        async ensureForSession() {
          return { profile: { theme: "t", worldBaseline: "w", narrationStyle: "n", boundaries: "" } };
        }
      } as never),
      globalProfileReadinessStore: input.globalProfileReadinessStore ?? ({
        async get() {
          return {
            persona: "ready",
            rp: "ready",
            updatedAt: 1
          };
        }
      } as never)
    },
    toolRuntime: {
      shellRuntime: input.shellRuntime ?? {
        isInputPromptCurrent() {
          return true;
        }
      }
    },
    lifecycle: {
      logger: pino({ level: "silent" }),
      sessionManager: input.sessionManager,
      userStore: sharedUserStore,
      userIdentityStore: input.userIdentityStore ?? ({
        async findInternalUserId() {
          return undefined;
        }
      } as never),
      persistSession: input.persistSession ?? (() => {}),
      getScheduler() {
        return {} as never;
      }
    }
  } as never;
}

  test("internal trigger dispatcher records received and queued transcript events", async () => {
    const config = createTestAppConfig();
    const sessionManager = new SessionManager(config);
    const sessionId = "qqbot:p:owner";
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
      userIdentityStore: {
        async findInternalUserId() {
          return "owner";
        }
      } as never,
      persistSession(_sessionId: string, reason: string) {
        persistedReasons.push(reason);
      }
    }, {
      async runInternalTriggerSession() {
        throw new Error("should not run immediately while session is busy");
      },
      wakeInlineBatch: () => {}
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

    await waitForCondition(() => {
      const currentSession = sessionManager.getSession(sessionId);
      return currentSession.pendingInternalTriggers.length === 1;
    });
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

  test("scheduled instruction queues behind pending group reply targets", async () => {
    const config = createTestAppConfig();
    const sessionManager = new SessionManager(config);
    const sessionId = "qqbot:g:20001";
    sessionManager.ensureSession({ id: sessionId, type: "group" });
    sessionManager.enqueueGroupReplyTarget(sessionId, {
      chatType: "group",
      userId: "u_b",
      groupId: "20001",
      senderName: "Bob",
      text: "@bot queued first",
      images: [],
      audioSources: [],
      audioIds: [],
      emojiSources: [],
      imageIds: [],
      emojiIds: [],
      attachments: [],
      forwardIds: [],
      replyMessageId: null,
      mentionUserIds: [],
      mentionedAll: false,
      isAtMentioned: true
    });
    let runImmediate = false;

    const dispatcher = createInternalTriggerDispatcher({
      logger: pino({ level: "silent" }),
      sessionManager,
      userStore: {
        async getByUserId() {
          return { nickname: "Owner" };
        }
      } as never,
      userIdentityStore: {
        async findInternalUserId() {
          return "owner";
        }
      } as never,
      persistSession() {}
    }, {
      async runInternalTriggerSession() {
        runImmediate = true;
      },
      wakeInlineBatch: () => {}
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
          ...(target.type === "group" ? { targetGroupId: target.groupId } : {}),
          jobName: "daily_reminder",
          instruction: "提醒喝水",
          enqueuedAt: 1
        };
      }
    });

    await waitForCondition(() => sessionManager.getSession(sessionId).pendingInternalTriggers.length === 1);
    assert.equal(runImmediate, false);
    const queuedTrigger = sessionManager.shiftInternalTrigger(sessionId);
    queuedTrigger?.resolveCompletion?.();
    await dispatchPromise;
  });

  test("internal trigger dispatcher resolves sender name through identity mapping for private sessions", async () => {
    const config = createTestAppConfig();
    const sessionManager = new SessionManager(config);
    const sessionId = "dev:p:2254600711";
    sessionManager.ensureSession({ id: sessionId, type: "private" });
    let capturedTrigger: { targetSenderName?: string } | null = null;

    const dispatcher = createInternalTriggerDispatcher({
      logger: pino({ level: "silent" }),
      sessionManager,
      userStore: {
        async getByUserId(userId: string) {
          return userId === "owner"
            ? { preferredAddress: "主人" }
            : null;
        }
      } as never,
      userIdentityStore: {
        async findInternalUserId(input: { externalId: string }) {
          return input.externalId === "2254600711" ? "owner" : undefined;
        }
      } as never,
      persistSession() {}
    }, {
      async runInternalTriggerSession(_targetSessionId, trigger) {
        capturedTrigger = { targetSenderName: trigger.targetSenderName };
      },
      wakeInlineBatch: () => {}
    });

    await dispatcher.dispatchTrigger({
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

    assert.deepEqual(capturedTrigger, {
      targetSenderName: "主人"
    });
  });

  test("internal trigger session records started transcript event", async () => {
    const config = createTestAppConfig();
    const sessionManager = new SessionManager(config);
    const sessionId = "qqbot:p:owner";
    sessionManager.ensureSession({ id: sessionId, type: "private" });
    const persistedReasons: string[] = [];

    const orchestrator = createGenerationSessionOrchestrator(createOrchestratorDeps({
      config,
      sessionManager,
      setupStore: {} as never,
      persistSession(_sessionId: string, reason: string) {
        persistedReasons.push(reason);
      }
    }), {
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

  test("scheduled instruction resets reply delivery to the session source", async () => {
    const config = createTestAppConfig();
    const sessionManager = new SessionManager(config);
    const sessionId = "web:test";
    sessionManager.ensureSession({ id: sessionId, type: "private", source: "web" });
    sessionManager.setReplyDelivery(sessionId, "onebot");
    const deliveries: Array<"onebot" | "web"> = [];

    const orchestrator = createGenerationSessionOrchestrator(createOrchestratorDeps({
      config,
      sessionManager,
      setupStore: {} as never,
      persistSession() {}
    }), {
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

  test("non-scheduled internal triggers keep the current reply delivery", async () => {
    const config = createTestAppConfig();
    const sessionManager = new SessionManager(config);
    const sessionId = "qqbot:p:owner";
    sessionManager.ensureSession({ id: sessionId, type: "private" });
    sessionManager.setReplyDelivery(sessionId, "web");
    const deliveries: Array<"onebot" | "web"> = [];

    const orchestrator = createGenerationSessionOrchestrator(createOrchestratorDeps({
      config,
      sessionManager,
      setupStore: {} as never,
      persistSession() {}
    }), {
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
      chatFilePaths: ["workspace/media/file-1.png"],
      comfyPromptId: "prompt-1",
      autoIterationIndex: 0,
      maxAutoIterations: 1
    });

    assert.deepEqual(deliveries, ["web"]);
    assert.equal(sessionManager.getReplyDelivery(sessionId), "web");
  });

  test("assistant internal trigger keeps participant extraction disabled but now carries global persona", async () => {
    const config = createTestAppConfig();
    const sessionManager = new SessionManager(config);
    const sessionId = "qqbot:p:owner";
    sessionManager.ensureSession({ id: sessionId, type: "private" });
    sessionManager.setModeId(sessionId, "assistant");

    let capturedPromptInput: any = null;
    let capturedRunInput: any = null;

    const orchestrator = createGenerationSessionOrchestrator(createOrchestratorDeps({
      config,
      sessionManager,
      userStore: {
        async getByUserId() {
          return { userId: "owner", relationship: "owner", memories: [{ id: "mem_1", title: "旧记忆", content: "不应出现", updatedAt: 1 }] };
        }
      } as never,
      personaStore: {
        async get() {
          return {
            ...createEmptyPersona(),
            name: "小满",
            temperament: "冷静",
            voiceStyle: "短句"
          };
        }
      } as never,
      setupStore: {} as never,
      persistSession() {}
    }), {
      promptBuilder: {
        async buildScheduledPromptMessages(input: any) {
          capturedPromptInput = input;
          return {
            promptMessages: [],
            debugSnapshot: {} as never
          };
        }
      } as never,
      async runGeneration(input) {
        capturedRunInput = input;
      },
      processNextSessionWork() {}
    });

    await orchestrator.runInternalTriggerSession(sessionId, {
      kind: "scheduled_instruction",
      targetType: "private",
      targetUserId: "owner",
      targetSenderName: "Owner",
      jobName: "daily",
      instruction: "帮我看一下当前目录",
      enqueuedAt: 1
    });

    assert.ok(capturedPromptInput);
    assert.equal(capturedPromptInput.modeId, "assistant");
    assert.deepEqual(capturedPromptInput.participantProfiles, []);
    assert.equal(capturedPromptInput.persona.name, "小满");
    assert.equal(capturedPromptInput.persona.temperament, "冷静");
    assert.equal(capturedPromptInput.currentUser.userId, "owner");
    assert.ok(capturedRunInput);
    assert.equal(capturedRunInput.availableToolsets.some((item: { id: string }) => item.id === "memory_profile"), false);
    assert.equal(capturedRunInput.availableToolsets.some((item: { id: string }) => item.id === "conversation_navigation"), false);
    assert.equal(capturedRunInput.availableToolsets.some((item: { id: string }) => item.id === "chat_delegation"), false);
  });

  test("scheduled private trigger resolves owner relationship from external user id", async () => {
    const config = createTestAppConfig();
    const sessionManager = new SessionManager(config);
    const sessionId = "dev:p:2254600711";
    sessionManager.ensureSession({ id: sessionId, type: "private" });

    let capturedPromptInput: any = null;

    const orchestrator = createGenerationSessionOrchestrator(createOrchestratorDeps({
      config,
      sessionManager,
      userStore: {
        async getByUserId(userId: string) {
          return userId === "owner"
            ? { userId: "owner", relationship: "owner" }
            : null;
        }
      } as never,
      userIdentityStore: {
        async findInternalUserId(input: { channelId: string; externalId: string }) {
          return input.channelId === "dev" && input.externalId === "2254600711"
            ? "owner"
            : undefined;
        }
      } as never,
      setupStore: {} as never,
      persistSession() {}
    }), {
      promptBuilder: {
        async buildScheduledPromptMessages(input: any) {
          capturedPromptInput = input;
          return {
            promptMessages: [],
            debugSnapshot: {} as never
          };
        }
      } as never,
      async runGeneration() {},
      processNextSessionWork() {}
    });

    await orchestrator.runInternalTriggerSession(sessionId, {
      kind: "scheduled_instruction",
      targetType: "private",
      targetUserId: "2254600711",
      targetSenderName: "Owner",
      jobName: "daily",
      instruction: "提醒喝水",
      enqueuedAt: 1
    });

    assert.equal(capturedPromptInput.relationship, "owner");
    assert.equal(capturedPromptInput.currentUser?.userId, "owner");
  });

  test("flush session prepare failure clears active response state", async () => {
    const config = createTestAppConfig();
    const sessionManager = new SessionManager(config);
    const sessionId = "qqbot:p:owner";
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

    const orchestrator = createGenerationSessionOrchestrator(createOrchestratorDeps({
      config,
      sessionManager,
      historyCompressor: {
        async maybeCompress() {
          throw new Error("compress failed");
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
    }), {
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

  test("scheduled trigger prepare failure clears active response state", async () => {
    const config = createTestAppConfig();
    const sessionManager = new SessionManager(config);
    const sessionId = "qqbot:p:owner";
    sessionManager.ensureSession({ id: sessionId, type: "private" });
    const persistedReasons: string[] = [];
    let processNextCalled = 0;

    const orchestrator = createGenerationSessionOrchestrator(createOrchestratorDeps({
      config,
      sessionManager,
      setupStore: {} as never,
      persistSession(_sessionId: string, reason: string) {
        persistedReasons.push(reason);
      }
    }), {
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

  test("stale terminal input trigger is skipped before starting generation", async () => {
    const config = createTestAppConfig();
    const sessionManager = new SessionManager(config);
    const sessionId = "qqbot:p:owner";
    sessionManager.ensureSession({ id: sessionId, type: "private" });
    let processNextCalled = 0;
    let runGenerationCalled = false;

    const orchestrator = createGenerationSessionOrchestrator(createOrchestratorDeps({
      config,
      sessionManager,
      setupStore: {} as never,
      shellRuntime: {
        isInputPromptCurrent() {
          return false;
        }
      }
    }), {
      promptBuilder: {
        async buildScheduledPromptMessages() {
          throw new Error("stale terminal input trigger should not build a prompt");
        }
      } as never,
      async runGeneration() {
        runGenerationCalled = true;
      },
      processNextSessionWork() {
        processNextCalled += 1;
      }
    });

    await orchestrator.runInternalTriggerSession(sessionId, {
      kind: "terminal_input_required",
      targetType: "private",
      targetUserId: "owner",
      targetSenderName: "Owner",
      jobName: "终端可能等待输入",
      instruction: "后台终端任务可能正在等待输入。请根据提示判断是否可以继续输入；不确定时向用户询问。",
      enqueuedAt: 1,
      resourceId: "res_shell_1",
      command: "npm install",
      cwd: "/tmp/project",
      promptKind: "confirmation",
      promptText: "Proceed? [y/N]",
      promptSignature: "confirmation:Proceed? [y/N]",
      detectedAtMs: 100,
      outputTail: "Proceed? [y/N] "
    });
    await flushMicrotasks();

    assert.equal(runGenerationCalled, false);
    assert.equal(sessionManager.hasActiveResponse(sessionId), false);
    assert.equal(processNextCalled, 1);
    assert.equal(sessionManager.getSession(sessionId).internalTranscript.length, 0);
  });

  test("non-scheduled trigger goes to inline queue when session is busy", async () => {
    const config = createTestAppConfig();
    const sessionManager = new SessionManager(config);
    const sessionId = "qqbot:p:owner";
    sessionManager.ensureSession({ id: sessionId, type: "private" });
    sessionManager.appendSyntheticPendingMessage(sessionId, {
      chatType: "private",
      userId: "owner",
      senderName: "Owner",
      text: "busy",
      images: []
    });
    let wakeCalled = false;

    const dispatcher = createInternalTriggerDispatcher({
      logger: pino({ level: "silent" }),
      sessionManager,
      userStore: {
        async getByUserId() {
          return { nickname: "Owner" };
        }
      } as never,
      userIdentityStore: {
        async findInternalUserId() {
          return "owner";
        }
      } as never,
      persistSession() {}
    }, {
      async runInternalTriggerSession() {
        throw new Error("should not run immediately while session is busy");
      },
      wakeInlineBatch() {
        wakeCalled = true;
      }
    });

    await dispatcher.dispatchTrigger({
      sessionId,
      queueLogEvent: "inline_trigger_queued",
      createTrigger(target) {
        return {
          kind: "terminal_session_closed",
          targetType: target.type,
          targetUserId: target.userId,
          targetSenderName: target.senderName,
          jobName: "终端任务已结束",
          instruction: "终端任务已结束",
          enqueuedAt: Date.now(),
          resourceId: "sh-1",
          command: "npm test",
          cwd: "/tmp",
          exitCode: 0,
          signal: null,
          output: "tests passed",
          outputTruncated: false
        };
      }
    });

    const session = sessionManager.getSession(sessionId);
    assert.equal(session.pendingInlineTriggers.length, 1);
    assert.equal(session.pendingInternalTriggers.length, 0);
    assert.equal(wakeCalled, false);

    const received = session.internalTranscript.find(
      (item) => item.kind === "internal_trigger_event" && item.stage === "received"
    );
    const queuedInline = session.internalTranscript.find(
      (item) => item.kind === "internal_trigger_event" && item.stage === "queued_inline"
    );
    assert.ok(received);
    assert.ok(queuedInline);
    if (queuedInline?.kind === "internal_trigger_event") {
      assert.equal(queuedInline.triggerKind, "terminal_session_closed");
    }
  });

  test("non-scheduled trigger calls wakeInlineBatch when session is idle", async () => {
    const config = createTestAppConfig();
    const sessionManager = new SessionManager(config);
    const sessionId = "qqbot:p:owner";
    sessionManager.ensureSession({ id: sessionId, type: "private" });
    let wakeCalled = false;

    const dispatcher = createInternalTriggerDispatcher({
      logger: pino({ level: "silent" }),
      sessionManager,
      userStore: {
        async getByUserId() {
          return { nickname: "Owner" };
        }
      } as never,
      userIdentityStore: {
        async findInternalUserId() {
          return "owner";
        }
      } as never,
      persistSession() {}
    }, {
      async runInternalTriggerSession() {
        throw new Error("should not run immediately for inline trigger");
      },
      wakeInlineBatch() {
        wakeCalled = true;
      }
    });

    await dispatcher.dispatchTrigger({
      sessionId,
      queueLogEvent: "inline_trigger_queued",
      createTrigger(target) {
        return {
          kind: "download_completed",
          targetType: target.type,
          targetUserId: target.userId,
          targetSenderName: target.senderName,
          jobName: "下载已完成",
          instruction: "下载已完成",
          enqueuedAt: Date.now(),
          resourceId: "dl-1",
          sourceUrl: "https://example.com/file.zip",
          fileId: "file-1",
          fileRef: "ref-1",
          chatFilePath: "workspace/media/file.zip",
          sourceName: "file.zip",
          mimeType: "application/zip",
          sizeBytes: 1024,
          fileKind: "document"
        };
      }
    });

    const session = sessionManager.getSession(sessionId);
    assert.equal(session.pendingInlineTriggers.length, 1);
    assert.equal(wakeCalled, true);
  });

  test("terminal close trigger supports web sessions", async () => {
    const config = createTestAppConfig();
    const sessionManager = new SessionManager(config);
    const sessionId = "web:test-terminal";
    sessionManager.ensureSession({
      id: sessionId,
      type: "private",
      source: "web",
      participantRef: { kind: "user", id: "owner" },
      title: "Web 测试"
    });
    let wakeSessionId: string | null = null;

    const dispatcher = createScheduledTaskDispatcher({
      logger: pino({ level: "silent" }),
      sessionManager,
      userStore: {
        async getByUserId() {
          return { nickname: "Owner" };
        }
      } as never,
      userIdentityStore: {
        async findInternalUserId() {
          return "owner";
        }
      } as never,
      persistSession() {}
    }, {
      async runInternalTriggerSession() {
        throw new Error("terminal close should be queued inline");
      },
      wakeInlineBatch(targetSessionId) {
        wakeSessionId = targetSessionId;
      }
    });

    await dispatcher.dispatchTerminalEvent({
      kind: "session_closed",
      owner: {
        sessionId,
        userId: "owner",
        senderName: "Owner"
      },
      resourceId: "res_shell_web",
      command: "echo ok",
      cwd: "/tmp",
      exitCode: 0,
      signal: null,
      output: "ok\n",
      outputTruncated: false
    });

    const session = sessionManager.getSession(sessionId);
    assert.equal(session.source, "web");
    assert.equal(session.pendingInlineTriggers.length, 1);
    assert.equal(wakeSessionId, sessionId);
    const trigger = session.pendingInlineTriggers[0];
    assert.equal(trigger?.kind, "terminal_session_closed");
    if (trigger?.kind === "terminal_session_closed") {
      assert.equal(trigger.targetType, "private");
      assert.equal(trigger.targetUserId, "owner");
      assert.equal(trigger.targetSenderName, "Owner");
      assert.equal(trigger.output, "ok\n");
    }
  });

  test("drainInlineTriggers atomically clears the queue", () => {
    const config = createTestAppConfig();
    const sessionManager = new SessionManager(config);
    const sessionId = "qqbot:p:owner";
    sessionManager.ensureSession({ id: sessionId, type: "private" });

    sessionManager.enqueueInlineTrigger(sessionId, {
      kind: "terminal_session_closed",
      targetType: "private",
      targetUserId: "owner",
      targetSenderName: "Owner",
      jobName: "job1",
      instruction: "task1",
      enqueuedAt: Date.now(),
      resourceId: "sh-1",
      command: "cmd1",
      cwd: "/tmp",
      exitCode: 0,
      signal: null,
      output: "out1",
      outputTruncated: false
    });
    sessionManager.enqueueInlineTrigger(sessionId, {
      kind: "download_completed",
      targetType: "private",
      targetUserId: "owner",
      targetSenderName: "Owner",
      jobName: "job2",
      instruction: "task2",
      enqueuedAt: Date.now(),
      resourceId: "dl-1",
      sourceUrl: "https://example.com/a",
      fileId: "f1",
      fileRef: "r1",
      chatFilePath: "p/f",
      sourceName: "f",
      mimeType: "text/plain",
      sizeBytes: 100,
      fileKind: "document"
    });

    assert.ok(sessionManager.hasPendingInlineTriggers(sessionId));
    const drained = sessionManager.drainInlineTriggers(sessionId);
    assert.equal(drained.length, 2);
    assert.equal(sessionManager.hasPendingInlineTriggers(sessionId), false);

    // second drain returns empty
    const drained2 = sessionManager.drainInlineTriggers(sessionId);
    assert.equal(drained2.length, 0);
  });

  test("consumeInlineTriggers flow: drain, transcript inlined, render batch message", () => {
    const config = createTestAppConfig();
    const sessionManager = new SessionManager(config);
    const sessionId = "qqbot:p:owner";
    sessionManager.ensureSession({ id: sessionId, type: "private" });

    sessionManager.enqueueInlineTrigger(sessionId, {
      kind: "terminal_session_closed",
      targetType: "private",
      targetUserId: "owner",
      targetSenderName: "Owner",
      jobName: "终端任务已结束 (npm test)",
      instruction: "后台终端任务已结束",
      enqueuedAt: Date.now(),
      resourceId: "sh-1",
      command: "npm test",
      cwd: "/tmp/project",
      exitCode: 0,
      signal: null,
      output: "8 tests passed",
      outputTruncated: false
    });
    sessionManager.enqueueInlineTrigger(sessionId, {
      kind: "download_completed",
      targetType: "private",
      targetUserId: "owner",
      targetSenderName: "Owner",
      jobName: "下载已完成 (data.zip)",
      instruction: "后台下载已完成",
      enqueuedAt: Date.now(),
      resourceId: "dl-1",
      sourceUrl: "https://example.com/data.zip",
      fileId: "file-1",
      fileRef: "ref-1",
      chatFilePath: "workspace/media/data.zip",
      sourceName: "data.zip",
      mimeType: "application/zip",
      sizeBytes: 2048,
      fileKind: "document"
    });

    const drained = sessionManager.drainInlineTriggers(sessionId);
    assert.equal(drained.length, 2);

    // Simulate what consumeInlineTriggers does in generationExecutor:
    // drain → write transcript inlined → render batch message
    for (const trigger of drained) {
      sessionManager.appendInternalTranscript(sessionId, createInternalTriggerEvent({
        trigger,
        stage: "inlined"
      }));
    }

    const message = renderInlineTriggerBatchMessage(drained);
    assert.equal(hasPromptSection(message, "background_event_batch"), true);
    assert.equal(parsePromptBlocks(message).some((block) => block.tag === "event" && block.attrs.kind === "terminal_session_closed"), true);
    assert.ok(message.includes("8 tests passed"));
    assert.equal(parsePromptBlocks(message).some((block) => block.tag === "event" && block.attrs.kind === "download_completed"), true);
    assert.ok(message.includes("data.zip"));
    assert.ok(findPromptBlock(message, "event"));
    assert.ok(message.includes("后台任务已就绪"));

    const session = sessionManager.getSession(sessionId);
    const inlined = session.internalTranscript.filter(
      (item) => item.kind === "internal_trigger_event" && item.stage === "inlined"
    );
    assert.equal(inlined.length, 2);
    if (inlined[0]?.kind === "internal_trigger_event") {
      assert.equal(inlined[0].triggerKind, "terminal_session_closed");
    }
    if (inlined[1]?.kind === "internal_trigger_event") {
      assert.equal(inlined[1].triggerKind, "download_completed");
    }
  });
