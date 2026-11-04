import { withMediaServices } from "../helpers/media-import-fixtures.ts";
import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { createGenerationExecutor } from "../../src/app/generation/generationExecutor.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { createEmptyPersona } from "../../src/persona/personaSchema.ts";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";

for (const failureStage of ["model", "delivery"] as const) {
test(`unrecoverable ${failureStage} failures send and persist an assistant fallback reply`, async () => {
  const config = createTestAppConfig({
    llm: {
      enabled: true
    }
  });
  const logger = pino({ level: "silent" });
  const sessionManager = new SessionManager(config);
  const sessionId = "qqbot:p:owner";
  const session = sessionManager.ensureSession({
    id: sessionId,
    type: "private"
  });
  const started = sessionManager.beginSyntheticGeneration(sessionId);
  const sentTexts: string[] = [];
  const sendAttempts: string[] = [];
  const persistedReasons: string[] = [];
  let processNextCalled = 0;

  const executor = createGenerationExecutor({
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
        async generate() {
          if (failureStage === "model") throw new Error("LLM API error: 400 Bad Request {\"error\":{\"type\":\"content_filter\"}}");
          return { text: "原始正文", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedTokens: null, reasoningTokens: 0, providerReported: false, requestCount: 1, modelRef: "main", model: "fake" } };
        }
      } as never,
      turnPlanner: {} as never,
        debounceManager: {} as never,
        historyCompressor: {
          async compactForRequest() {
            return false;
          }
        } as never,
        sessionCaptioner: {
          async generateTitle() {
            return null;
          }
        } as never,
        messageQueue: {
          async enqueueText(params: {
            send: () => Promise<void>;
          }) {
            await params.send();
        },
        getDrainPromise() {
          return null;
        }
      } as never,
      sessionManager
    },
    toolRuntime: withMediaServices({
      oneBotClient: {
        async sendText(params: { text: string }) {
          sendAttempts.push(params.text);
          if (failureStage === "delivery" && sendAttempts.length === 1) throw new Error("injected body send failure");
          sentTexts.push(params.text);
          return {
            status: "ok",
            retcode: 0,
            data: {
              message_id: sentTexts.length
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
      temporaryWorkspaceService: { async init() {}, list() { return []; } } as any,
      localFileService: {} as never,
      chatFileStore: {} as never,
      downloadRuntime: {} as never,
      mediaInspectionService: {} as never,
      textInspectionService: {} as never,
      comfyClient: {} as never,
      comfyTaskStore: {} as never,
      comfyTemplateCatalog: {} as never,
      oneBotReferenceResolver: {} as never
    }),
    identity: {
      userStore: {} as never,
      contextStore: {} as never,
      whitelistStore: {} as never,
      personaStore: {} as never,
      rpProfileStore: {} as never,
      globalRuleStore: {} as never,
      toolsetRuleStore: {} as never,
      scenarioHostStateStore: {} as never,
      setupStore: {
        async isReady() {
          return false;
        }
      } as never,
      globalProfileReadinessStore: {} as never,
      conversationAccess: {} as never,
      npcDirectory: {} as never
    },
    lifecycle: {
      logger,
      sessionManager,
      userStore: {} as never,
      userIdentityStore: {} as never,
      persistSession(_sessionId: string, reason: string) {
        persistedReasons.push(reason);
      },
      getScheduler() {
        return {} as never;
      }
    }
  }, {
    processNextSessionWork() {
      processNextCalled += 1;
    }
  });

  const runInput = {
    sessionId,
    expectedEpoch: session.mutationEpoch,
    responseAbortController: started.responseAbortController,
    responseEpoch: started.responseEpoch,
    abortController: started.abortController,
    modeId: "assistant",
    relationship: "owner",
    interactionMode: "normal",
    internalTranscript: [],
    debugMarkers: [],
    currentUser: null as never,
    persona: createEmptyPersona(),
    batchMessages: [{
      chatType: "private",
      userId: "owner",
      senderName: "Owner",
      text: "帮我查一下",
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
    }],
    sendTarget: {
      delivery: "onebot",
      chatType: "private",
      userId: "owner",
      senderName: "Owner"
    },
    participantProfiles: [],
    promptMessages: [{
      role: "user",
      content: "帮我查一下"
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
      debugMarkers: [],
      toolTranscript: [],
      persona: createEmptyPersona(),
      globalRules: [],
      toolsetRules: [],
      currentUser: null as never,
      participantProfiles: [],
      imageCaptions: [],
      lastLlmUsage: null
    },
    availableToolNames: [],
    streamResponse: true
  } satisfies Parameters<typeof executor.runGeneration>[0];
  if (failureStage === "delivery") await assert.rejects(executor.runGeneration(runInput), /injected body send failure/);
  else await executor.runGeneration(runInput);

  assert.equal(processNextCalled, 1);
  assert.equal(sentTexts.length, 1);
  assert.equal(
    sentTexts[0],
    "刚刚这次回复失败了，我暂时没拿到可用结果。你可以稍后重试；如果连续出现，请检查模型配置、上游接口状态或服务日志。"
  );
  const llmVisibleHistory = sessionManager.getLlmVisibleHistory(sessionId);
  assert.equal(llmVisibleHistory.length, 1);
  assert.equal(llmVisibleHistory[0]?.role, "assistant");
  assert.equal(
    llmVisibleHistory[0]?.content,
    "刚刚这次回复失败了，我暂时没拿到可用结果。你可以稍后重试；如果连续出现，请检查模型配置、上游接口状态或服务日志。"
  );
  const finalSession = sessionManager.getSession(sessionId);
  const fallbackEvent = finalSession.internalTranscript.find((item) => item.kind === "fallback_event");
  assert.equal(finalSession.publishedConversation ?? null, null);
  assert.ok(!persistedReasons.includes("cross_conversation_reply_published"));
  assert.ok(fallbackEvent);
  assert.equal(fallbackEvent?.fallbackType, "generation_failure_reply");
  assert.equal(fallbackEvent?.failureMessage, sentTexts[0]);
  assert.match(fallbackEvent?.details ?? "", failureStage === "model" ? /LLM API error: 400 Bad Request/ : /injected body send failure/);
  assert.ok(persistedReasons.includes("assistant_response_finalized"));
  assert.ok(persistedReasons.includes("generation_finished"));
  assert.ok(persistedReasons.includes("internal_transcript_updated"));
  if (failureStage === "delivery") {
    assert.deepEqual(sendAttempts, ["原始正文", sentTexts[0]]);
    assert.equal(sessionManager.isGenerating(sessionId), false);
    const next = sessionManager.beginSyntheticGeneration(sessionId);
    await executor.runGeneration({ ...runInput, expectedEpoch: sessionManager.getMutationEpoch(sessionId),
      abortController: next.abortController, responseAbortController: next.responseAbortController, responseEpoch: next.responseEpoch });
    assert.equal(processNextCalled, 2);
    assert.deepEqual(sentTexts, [fallbackEvent?.failureMessage, "原始正文"]);
  }
});
}
