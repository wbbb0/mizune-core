import assert from "node:assert/strict";
import pino from "pino";
import { createGenerationExecutor } from "../../src/app/generation/generationExecutor.ts";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { runCase } from "../helpers/config-test-support.tsx";

function createUsage() {
  return {
    modelRef: "main",
    model: "fake",
    provider: "test",
    inputTokens: 1,
    outputTokens: 1,
    reasoningTokens: 0,
    cachedInputTokens: null,
    providerReported: false,
    requestCount: 1
  };
}

function createBatchMessage() {
  return {
    chatType: "private" as const,
    userId: "owner",
    senderName: "Owner",
    text: "你好",
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
    isAtMentioned: false,
    receivedAt: Date.now()
  };
}

async function waitForEvents(events: string[], count: number): Promise<void> {
  const deadline = Date.now() + 400;
  while (events.length < count) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${count} events, got ${events.length}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function createExecutorHarness(options?: {
  failAfterReasoning?: boolean;
  waitForAbortGraceWindow?: (signal: AbortSignal) => Promise<void>;
}) {
  const config = createTestAppConfig({
    llm: {
      enabled: true
    }
  });
  const logger = pino({ level: "silent" });
  const sessionManager = new SessionManager(config);
  const sessionId = "private:owner";
  sessionManager.ensureSession({ id: sessionId, type: "private" });
  const started = sessionManager.beginSyntheticGeneration(sessionId);
  const events: string[] = [];
  let resolveDrain!: () => void;
  const drainPromise = new Promise<void>((resolve) => {
    resolveDrain = resolve;
  });

  const executor = (createGenerationExecutor as any)({
    promptBuilder: {
      config,
      mediaVisionService: {} as never,
      mediaCaptionService: {} as never
    },
    sessionRuntime: {
      logger,
      llmClient: {
        isConfigured() {
          return true;
        },
      async generate(input: {
        onReasoningDelta?: (delta: string) => void;
        onTextDelta?: (delta: string) => Promise<void>;
      }) {
        input.onReasoningDelta?.("先想一下");
        if (options?.failAfterReasoning) {
          throw new Error("LLM failed after reasoning");
        }
        await input.onTextDelta?.("你好");
        return {
            text: "你好",
            reasoningContent: "",
            usage: createUsage()
          };
        }
      } as never,
      turnPlanner: {} as never,
      debounceManager: {} as never,
      historyCompressor: {
        async maybeCompress() {
          return false;
        }
      } as never,
      messageQueue: {
        async enqueueText(params: {
          send: () => Promise<void>;
        }) {
          await params.send();
        },
        getDrainPromise() {
          return drainPromise;
        }
      } as never,
      sessionManager
    },
    toolRuntime: {
      oneBotClient: {
        async setTyping(params: { enabled: boolean }) {
          events.push(params.enabled ? "typing:start" : "typing:stop");
          return true;
        },
        async sendText(params: { text: string }) {
          events.push(`send:${params.text}`);
          return {
            status: "ok",
            retcode: 0,
            data: {
              message_id: 1
            }
          };
        }
      } as never,
      audioStore: {} as never,
      requestStore: {} as never,
      scheduledJobStore: {} as never,
      shellRuntime: {} as never,
      searchService: {} as never,
      browserService: {} as never,
      localFileService: {} as never,
      chatFileStore: {} as never,
      comfyClient: {} as never,
      comfyTaskStore: {} as never,
      comfyTemplateCatalog: {} as never,
      forwardResolver: {} as never
    },
    identity: {
      userStore: {} as never,
      whitelistStore: {} as never,
      personaStore: {} as never,
      globalRuleStore: {} as never,
      toolsetRuleStore: {} as never,
      scenarioHostStateStore: {} as never,
      setupStore: {
        async isReady() {
          return false;
        }
      } as never,
      conversationAccess: {} as never,
      npcDirectory: {} as never
    },
    lifecycle: {
      logger,
      sessionManager,
      userStore: {} as never,
      persistSession() {},
      getScheduler() {
        return {} as never;
      }
    }
  }, {
    processNextSessionWork() {}
  }, {
    waitForAbortGraceWindow: options?.waitForAbortGraceWindow ?? (async () => {})
  });

  const runPromise = executor.runGeneration({
    sessionId,
    expectedEpoch: sessionManager.getSession(sessionId).mutationEpoch,
    responseAbortController: started.responseAbortController,
    responseEpoch: started.responseEpoch,
    abortController: started.abortController,
    relationship: "owner",
    interactionMode: "normal",
    internalTranscript: [],
    debugMarkers: [],
    currentUser: null as never,
    persona: null as never,
    batchMessages: [createBatchMessage()],
    sendTarget: {
      delivery: "onebot",
      chatType: "private",
      userId: "owner",
      senderName: "Owner"
    },
    participantProfiles: [],
    promptMessages: [{
      role: "user",
      content: "你好"
    }],
    resolvedModelRef: ["main"],
    debugSnapshot: {
      sessionId,
      systemMessages: [],
      visibleToolNames: [],
      activeToolsets: [],
      historySummary: null,
      recentHistory: [],
      currentBatch: [],
      liveResources: [],
      recentToolEvents: [],
      debugMarkers: [],
      toolTranscript: [],
      persona: null as never,
      globalRules: [],
      toolsetRules: [],
      currentUser: null as never,
      participantProfiles: [],
      imageCaptions: [],
      lastLlmUsage: null
    },
    availableToolNames: [],
    streamResponse: true
  });

  return {
    sessionId,
    started,
    sessionManager,
    events,
    runPromise,
    resolveDrain
  };
}

async function main() {
  await runCase("typing starts on reasoning and stops after outbound drain", async () => {
    const harness = createExecutorHarness();

    await waitForEvents(harness.events, 2);
    assert.deepEqual(harness.events, ["typing:start", "send:你好"]);

    harness.resolveDrain();
    await harness.runPromise;

    assert.deepEqual(harness.events, ["typing:start", "send:你好", "typing:stop"]);
  });

  await runCase("typing stop is skipped when a newer response epoch takes over", async () => {
    const harness = createExecutorHarness();

    await waitForEvents(harness.events, 2);
    harness.sessionManager.beginSyntheticGeneration(harness.sessionId);
    harness.resolveDrain();
    await harness.runPromise;

    assert.deepEqual(harness.events, ["typing:start", "send:你好"]);
  });

  await runCase("typing also stops after fallback delivery on generation failure", async () => {
    const harness = createExecutorHarness({ failAfterReasoning: true });

    await waitForEvents(harness.events, 2);
    harness.resolveDrain();
    await harness.runPromise;

    assert.deepEqual(harness.events, [
      "typing:start",
      "send:刚刚这次回复失败了，我暂时没拿到可用结果。你可以稍后重试；如果连续出现，请检查模型配置、上游接口状态或服务日志。",
      "typing:stop"
    ]);
  });

  await runCase("typing tests can bypass abort grace delay via injected wait function", async () => {
    let waited = false;
    const harness = createExecutorHarness({
      async waitForAbortGraceWindow() {
        waited = true;
      }
    });

    await waitForEvents(harness.events, 2);
    harness.resolveDrain();
    await harness.runPromise;

    assert.equal(waited, true);
    assert.deepEqual(harness.events, ["typing:start", "send:你好", "typing:stop"]);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
