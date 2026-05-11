import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSessionWorkCoordinatorDeps,
  createComfyTaskNotifications
} from "../../src/app/runtime/runtimeDependencyBuilders.ts";

function createServicesFixture() {
  return {
    config: { key: "config" },
    logger: { key: "logger" },
    llmClient: { key: "llmClient" },
    turnPlanner: { key: "turnPlanner" },
    debounceManager: { key: "debounceManager" },
    historyCompressor: { key: "historyCompressor" },
    messageQueue: { key: "messageQueue" },
    oneBotClient: { key: "oneBotClient" },
    sessionManager: { key: "sessionManager" },
    audioTranscriber: { key: "audioTranscriber" },
    audioStore: { key: "audioStore" },
    requestStore: { key: "requestStore" },
    whitelistStore: { key: "whitelistStore" },
    scheduledJobStore: { key: "scheduledJobStore" },
    shellRuntime: { key: "shellRuntime" },
    searchService: { key: "searchService" },
    browserService: { key: "browserService" },
    localFileService: { key: "localFileService" },
    chatFileStore: { key: "chatFileStore" },
    mediaVisionService: { key: "mediaVisionService" },
    mediaCaptionService: { key: "mediaCaptionService" },
    comfyClient: { key: "comfyClient" },
    comfyTaskStore: { key: "comfyTaskStore" },
    comfyTemplateCatalog: { key: "comfyTemplateCatalog" },
    forwardResolver: { key: "forwardResolver" },
    userStore: { key: "userStore" },
    personaStore: { key: "personaStore" },
    globalRuleStore: { key: "globalRuleStore" },
    toolsetRuleStore: { key: "toolsetRuleStore" },
    scenarioHostStateStore: { key: "scenarioHostStateStore" },
    setupStore: { key: "setupStore" },
    conversationAccess: { key: "conversationAccess" },
    npcDirectory: { key: "npcDirectory" }
  } as any;
}

function createTaskFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    sessionId: "qqbot:p:owner",
    userId: "owner",
    templateId: "portrait",
    workflowFile: "portrait.json",
    workflowSnapshot: {},
    positivePrompt: "sunset",
    aspectRatio: "1:1",
    resolvedWidth: 1024,
    resolvedHeight: 1024,
    comfyPromptId: "prompt-1",
    status: "running",
    resultFileIds: [],
    resultFiles: [],
    autoIterationIndex: 1,
    maxAutoIterations: 3,
    lastError: null,
    createdAtMs: 1,
    updatedAtMs: 2,
    startedAtMs: 2,
    finishedAtMs: null,
    ...overrides
  } as any;
}

  test("buildSessionWorkCoordinatorDeps keeps wiring references stable", async () => {
    const services = createServicesFixture();
    const persistSession = () => {};
    const getScheduler = () => ({ key: "scheduler" } as any);
    const deps = buildSessionWorkCoordinatorDeps(services, persistSession, getScheduler);

    assert.equal(deps.promptBuilder.config, services.config);
    assert.equal(deps.promptBuilder.mediaVisionService, services.mediaVisionService);
    assert.equal(deps.sessionRuntime.logger, services.logger);
    assert.equal(deps.sessionRuntime.sessionManager, services.sessionManager);
    assert.equal(deps.identity.userStore, services.userStore);
    assert.equal(deps.identity.npcDirectory, services.npcDirectory);
    assert.equal(deps.toolRuntime.browserService, services.browserService);
    assert.equal(deps.toolRuntime.forwardResolver, services.forwardResolver);
    assert.equal(deps.lifecycle.persistSession, persistSession);
    assert.equal(deps.lifecycle.getScheduler, getScheduler);
  });

  test("createComfyTaskNotifications builds completion trigger payloads", async () => {
    const dispatched: Array<{ sessionId: string; event: any }> = [];
    const notifications = createComfyTaskNotifications({
      async dispatchInternalTrigger() {},
      async dispatchComfyEvent(event: any) {
        dispatched.push({ sessionId: event.owner.sessionId, event });
      }
    } as any);

    await notifications.notifyCompletedTask(createTaskFixture(), [
      { fileId: "file-1", path: "workspace/image.png" },
      { fileId: "file-2", path: "workspace/image-2.png" }
    ]);

    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0]?.sessionId, "qqbot:p:owner");
    assert.equal(dispatched[0]?.event.kind, "comfy_task_completed");
    assert.equal(dispatched[0]?.event.owner.userId, "owner");
    assert.deepEqual(dispatched[0]?.event.workspaceFileIds, ["file-1", "file-2"]);
    assert.deepEqual(dispatched[0]?.event.chatFilePaths, ["workspace/image.png", "workspace/image-2.png"]);
    assert.equal(dispatched[0]?.event.templateId, "portrait");
  });

  test("createComfyTaskNotifications builds failed trigger payloads with default error", async () => {
    const dispatched: Array<any> = [];
    const notifications = createComfyTaskNotifications({
      async dispatchInternalTrigger() {},
      async dispatchComfyEvent(event: any) {
        dispatched.push(event);
      }
    } as any);

    await notifications.notifyFailedTask(createTaskFixture({ lastError: null }));

    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0]?.kind, "comfy_task_failed");
    assert.equal(dispatched[0]?.owner.userId, "owner");
    assert.equal(dispatched[0]?.lastError, "Comfy task failed");
    assert.equal(dispatched[0]?.templateId, "portrait");
  });
