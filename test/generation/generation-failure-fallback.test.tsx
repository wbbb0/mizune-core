import assert from "node:assert/strict";
import pino from "pino";
import { createGenerationExecutor } from "../../src/app/generation/generationExecutor.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";

async function main() {
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
          throw new Error("LLM API error: 400 Bad Request {\"error\":{\"type\":\"content_filter\"}}");
        }
      } as never,
      turnPlanner: {} as never,
        debounceManager: {} as never,
        historyCompressor: {
          async maybeCompress() {
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
    toolRuntime: {
      oneBotClient: {
        async sendText(params: { text: string }) {
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

  await executor.runGeneration({
    sessionId,
    expectedEpoch: session.mutationEpoch,
    responseAbortController: started.responseAbortController,
    responseEpoch: started.responseEpoch,
    abortController: started.abortController,
    relationship: "owner",
    interactionMode: "normal",
    internalTranscript: [],
    debugMarkers: [],
    currentUser: null as never,
    persona: null as never,
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
  assert.ok(fallbackEvent);
  assert.equal(fallbackEvent?.fallbackType, "generation_failure_reply");
  assert.equal(fallbackEvent?.failureMessage, sentTexts[0]);
  assert.match(fallbackEvent?.details ?? "", /LLM API error: 400 Bad Request/);
  assert.ok(persistedReasons.includes("assistant_response_finalized"));
  assert.ok(persistedReasons.includes("generation_finished"));
  assert.ok(persistedReasons.includes("internal_transcript_updated"));
  process.stdout.write("- unrecoverable model failures send and persist an assistant fallback reply ... ok\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
