import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { createGenerationExecutor } from "../../src/app/generation/generationExecutor.ts";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

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

async function waitForCondition(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 400;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(message);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function createExecutorHarness(options?: {
  failAfterReasoning?: boolean;
  waitForAbortGraceWindow?: (signal: AbortSignal) => Promise<void>;
  configOverrides?: Parameters<typeof createTestAppConfig>[0];
  sessionSource?: "onebot" | "web";
  sessionId?: string;
  titleSource?: "default" | "auto" | "manual" | null;
  historyCompressed?: boolean;
  forceRegenerateTitleAfterTurn?: boolean;
  captureDraftOverlay?: boolean;
  onGenerateTitle?: () => Promise<string | null> | string | null;
  customGenerate?: (input: {
    onReasoningDelta?: (delta: string) => void;
    onTextDelta?: (delta: string) => Promise<void>;
    onProviderResponseComplete?: (event: {
      phase: "tool_call" | "final_response" | "fallback_response";
      text: string;
      toolCalls: Array<{
        id: string;
        type: "function";
        function: {
          name: string;
          arguments: string;
        };
      }>;
    }) => Promise<void>;
    abortSignal?: AbortSignal;
    onAssistantToolCalls?: (message: {
      role: "assistant";
      content: string;
      tool_calls: Array<{
        id: string;
        type: "function";
        function: {
          name: string;
          arguments: string;
        };
      }>;
    }) => Promise<void>;
    onToolResultMessage?: (message: {
      role: "tool";
      tool_call_id: string;
      content: string;
    }, toolName: string) => Promise<void>;
  }) => Promise<{
    text: string;
    reasoningContent?: string;
    usage: ReturnType<typeof createUsage>;
  }>;
}) {
  const config = createTestAppConfig({
    llm: {
      enabled: true
    },
    ...(options?.configOverrides ?? {})
  });
  const logger = pino({ level: "silent" });
  const sessionManager = new SessionManager(config);
  const sessionId = options?.sessionId ?? "qqbot:p:owner";
  const delivery = options?.sessionSource === "web" ? "web" : "onebot";
  sessionManager.ensureSession({
    id: sessionId,
    type: "private",
    source: options?.sessionSource ?? "onebot",
    title: options?.sessionSource === "web" ? "New Chat" : null,
    titleSource: options?.titleSource ?? null
  });
  const started = sessionManager.beginSyntheticGeneration(sessionId);
  const events: string[] = [];
  const typingCalls: Array<{ enabled: boolean; userId: string; groupId?: string }> = [];
  const sendTextCalls: Array<{ text: string; userId?: string; groupId?: string }> = [];
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
        abortSignal?: AbortSignal;
        onReasoningDelta?: (delta: string) => void;
        onTextDelta?: (delta: string) => Promise<void>;
        onProviderResponseComplete?: (event: {
          phase: "tool_call" | "final_response" | "fallback_response";
          text: string;
          toolCalls: Array<{
            id: string;
            type: "function";
            function: {
              name: string;
              arguments: string;
            };
          }>;
        }) => Promise<void>;
      }) {
        if (options?.customGenerate) {
          return await options.customGenerate(input);
        }
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
          if (options?.historyCompressed) {
            events.push("history:compressed");
            return true;
          }
          return false;
        }
      } as never,
      sessionCaptioner: {
        isAvailable() {
          return true;
        },
        async generateTitle() {
          events.push("title:generate");
          const result = await options?.onGenerateTitle?.();
          return result ?? null;
        }
      } as never,
      messageQueue: {
        async enqueueText(params: {
          pacing?: "humanized" | "immediate";
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
        async setTyping(params: { enabled: boolean; userId: string; groupId?: string }) {
          typingCalls.push(params);
          events.push(params.enabled ? "typing:start" : "typing:stop");
          return true;
        },
        async sendText(params: { text: string; userId?: string; groupId?: string }) {
          sendTextCalls.push(params);
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
      delivery,
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
    streamResponse: true,
    forceRegenerateTitleAfterTurn: options?.forceRegenerateTitleAfterTurn,
    ...(delivery === "web"
      ? {
          committedTextSink: {
            async commitText(text: string) {
              events.push(`send:${text}`);
            }
          },
          ...(options?.captureDraftOverlay
            ? {
                draftOverlaySink: {
                  appendDelta(delta: string) {
                    events.push(`draft:${delta}`);
                  },
                  markCommitted() {
                    events.push("draft:committed");
                  },
                  complete() {
                    events.push("draft:complete");
                  },
                  fail(message: string) {
                    events.push(`draft:fail:${message}`);
                  }
                }
              }
            : {})
        }
      : {})
  });

  return {
    sessionId,
    started,
    sessionManager,
    events,
    typingCalls,
    sendTextCalls,
    runPromise,
    resolveDrain
  };
}

  test("typing starts on reasoning and stops after outbound drain", async () => {
    const harness = createExecutorHarness();

    await waitForEvents(harness.events, 2);
    assert.deepEqual(harness.events, ["typing:start", "send:你好"]);

    harness.resolveDrain();
    await harness.runPromise;

    assert.deepEqual(harness.events, ["typing:start", "send:你好", "typing:stop"]);
  });

  test("typing stop is skipped when a newer response epoch takes over", async () => {
    const harness = createExecutorHarness();

    await waitForEvents(harness.events, 2);
    harness.sessionManager.beginSyntheticGeneration(harness.sessionId);
    harness.resolveDrain();
    await harness.runPromise;

    assert.deepEqual(harness.events, ["typing:start", "send:你好"]);
  });

  test("typing stops when the active response is interrupted", async () => {
    const harness = createExecutorHarness({
      customGenerate: async (input) => {
        input.onReasoningDelta?.("先想一下");
        await waitForCondition(
          () => input.abortSignal?.aborted === true,
          "Timed out waiting for interrupt abort"
        );
        throw new Error("aborted");
      }
    });

    await waitForEvents(harness.events, 1);
    harness.sessionManager.interruptResponse(harness.sessionId);

    await harness.runPromise;
    assert.deepEqual(harness.events, ["typing:start", "typing:stop"]);
  });

  test("web draft overlay completes when the active response is interrupted", async () => {
    const harness = createExecutorHarness({
      sessionSource: "web",
      captureDraftOverlay: true,
      configOverrides: {
        conversation: {
          outbound: {
            disableStreamingSplit: true
          }
        }
      },
      customGenerate: async (input) => {
        await input.onTextDelta?.("这段已经流式展示但还没有提交。");
        await waitForCondition(
          () => input.abortSignal?.aborted === true,
          "Timed out waiting for interrupt abort"
        );
        throw new Error("aborted");
      }
    });

    await waitForEvents(harness.events, 1);
    harness.sessionManager.interruptResponse(harness.sessionId);

    await harness.runPromise;
    assert.deepEqual(harness.events, [
      "draft:这段已经流式展示但还没有提交。",
      "draft:complete"
    ]);
    assert.deepEqual(harness.sessionManager.getLlmVisibleHistory(harness.sessionId).map((item) => ({
      role: item.role,
      content: item.content
    })), [
      {
        role: "assistant",
        content: "这段已经流式展示但还没有提交。"
      }
    ]);
  });

  test("typing also stops after fallback delivery on generation failure", async () => {
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

  test("private onebot delivery resolves external session target for typing and outbound send", async () => {
    const harness = createExecutorHarness({
      sessionId: "qqbot:p:2254600711"
    });

    await waitForEvents(harness.events, 2);
    harness.resolveDrain();
    await harness.runPromise;

    assert.deepEqual(harness.typingCalls, [
      { enabled: true, chatType: "private", userId: "2254600711" },
      { enabled: false, chatType: "private", userId: "2254600711" }
    ]);
    assert.deepEqual(harness.sendTextCalls, [{
      userId: "2254600711",
      text: "你好"
    }]);
  });

  test("onebot delivery sends plain text while storing markdown response text", async () => {
    const harness = createExecutorHarness({
      customGenerate: async (input) => {
        await input.onTextDelta?.("**重点**\n\n- 第一项\n- 第二项\n\n```ts\nconst value = 1;\n```");
        return {
          text: "**重点**\n\n- 第一项\n- 第二项\n\n```ts\nconst value = 1;\n```",
          reasoningContent: "",
          usage: createUsage()
        };
      }
    });

    await waitForEvents(harness.events, 2);
    harness.resolveDrain();
    await harness.runPromise;

    assert.deepEqual(harness.sendTextCalls, [
      {
        userId: "owner",
        text: ["重点", "", "· 第一项", "· 第二项"].join("\n")
      },
      {
        userId: "owner",
        text: "const value = 1;"
      }
    ]);

    const assistantHistoryText = harness.sessionManager
      .getSession(harness.sessionId)
      .internalTranscript
      .filter((item) => item.kind === "assistant_message")
      .map((item) => item.text)
      .join("\n\n");
    assert.equal(
      assistantHistoryText,
      "**重点**\n\n- 第一项\n- 第二项\n\n```ts\nconst value = 1;\n```"
    );
  });

  test("typing tests can bypass abort grace delay via injected wait function", async () => {
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

  test("web delivery waits for paragraph boundaries instead of sentence boundaries", async () => {
    let continueAfterSentence!: () => void;
    const continueAfterSentencePromise = new Promise<void>((resolve) => {
      continueAfterSentence = resolve;
    });
    let sentenceSeen!: () => void;
    const sentenceSeenPromise = new Promise<void>((resolve) => {
      sentenceSeen = resolve;
    });
    let continueAfterParagraphBoundary!: () => void;
    const continueAfterParagraphBoundaryPromise = new Promise<void>((resolve) => {
      continueAfterParagraphBoundary = resolve;
    });
    const harness = createExecutorHarness({
      sessionSource: "web",
      customGenerate: async (input) => {
        input.onReasoningDelta?.("先想一下");
        await input.onTextDelta?.("第一段确实足够长但不会按句号提交。");
        sentenceSeen();
        await continueAfterSentencePromise;
        await input.onTextDelta?.("第二句仍然属于同一段。\n\n");
        await continueAfterParagraphBoundaryPromise;
        await input.onTextDelta?.("第二段会等到收尾提交。");
        return {
          text: "第一段确实足够长但不会按句号提交。第二句仍然属于同一段。\n\n第二段会等到收尾提交。",
          reasoningContent: "",
          usage: createUsage()
        };
      }
    });

    await sentenceSeenPromise;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(harness.events, []);

    continueAfterSentence();
    await waitForEvents(harness.events, 1);
    assert.deepEqual(harness.events, [
      "send:第一段确实足够长但不会按句号提交。第二句仍然属于同一段。"
    ]);

    continueAfterParagraphBoundary();
    harness.resolveDrain();
    await harness.runPromise;

    assert.deepEqual(harness.events, [
      "send:第一段确实足够长但不会按句号提交。第二句仍然属于同一段。",
      "send:第二段会等到收尾提交。"
    ]);
  });

  test("disableStreamingSplit waits for the complete text before outbound send", async () => {
    let continueStreaming!: () => void;
    const continuePromise = new Promise<void>((resolve) => {
      continueStreaming = resolve;
    });
    let firstDeltaSeen!: () => void;
    const firstDeltaSeenPromise = new Promise<void>((resolve) => {
      firstDeltaSeen = resolve;
    });

    const harness = createExecutorHarness({
      sessionSource: "web",
      configOverrides: {
        conversation: {
          outbound: {
            disableStreamingSplit: true
          }
        }
      },
      customGenerate: async (input) => {
        input.onReasoningDelta?.("先想一下");
        await input.onTextDelta?.("第一段确实足够长而且不会立即单独发送。");
        firstDeltaSeen();
        await continuePromise;
        await input.onTextDelta?.("第二段同样足够长而且会在结束后一起发送。");
        return {
          text: "第一段确实足够长而且不会立即单独发送。第二段同样足够长而且会在结束后一起发送。",
          reasoningContent: "",
          usage: createUsage()
        };
      }
    });

    await firstDeltaSeenPromise;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(harness.events, []);

    continueStreaming();
    await waitForEvents(harness.events, 1);
    assert.deepEqual(harness.events, [
      "send:第一段确实足够长而且不会立即单独发送。第二段同样足够长而且会在结束后一起发送。"
    ]);

    harness.resolveDrain();
    await harness.runPromise;

    assert.deepEqual(harness.events, ["send:第一段确实足够长而且不会立即单独发送。第二段同样足够长而且会在结束后一起发送。"]);
  });

  test("tool-call provider response boundary commits buffered text even when streaming split is disabled", async () => {
    let continueAfterToolBoundary!: () => void;
    const continueAfterToolBoundaryPromise = new Promise<void>((resolve) => {
      continueAfterToolBoundary = resolve;
    });
    let toolBoundarySeen!: () => void;
    const toolBoundarySeenPromise = new Promise<void>((resolve) => {
      toolBoundarySeen = resolve;
    });

    const harness = createExecutorHarness({
      sessionSource: "web",
      configOverrides: {
        conversation: {
          outbound: {
            disableStreamingSplit: true
          }
        }
      },
      customGenerate: async (input) => {
        await input.onTextDelta?.("我先查一下");
        await input.onProviderResponseComplete?.({
          phase: "tool_call",
          text: "我先查一下",
          toolCalls: [{
            id: "call_lookup_1",
            type: "function",
            function: {
              name: "lookup",
              arguments: "{}"
            }
          }]
        });
        await input.onAssistantToolCalls?.({
          role: "assistant",
          content: "我先查一下",
          tool_calls: [{
            id: "call_lookup_1",
            type: "function",
            function: {
              name: "lookup",
              arguments: "{}"
            }
          }]
        });
        toolBoundarySeen();
        await continueAfterToolBoundaryPromise;
        await input.onTextDelta?.("查完了。");
        return {
          text: "查完了。",
          reasoningContent: "",
          usage: createUsage()
        };
      }
    });

    await toolBoundarySeenPromise;
    await waitForEvents(harness.events, 1);
    assert.deepEqual(harness.events, ["send:我先查一下"]);

    continueAfterToolBoundary();
    await waitForEvents(harness.events, 2);
    assert.deepEqual(harness.events, ["send:我先查一下", "send:查完了。"]);

    harness.resolveDrain();
    await harness.runPromise;
  });

  test("tool-call provider response boundary commits short buffered text before splitter threshold", async () => {
    let continueAfterToolBoundary!: () => void;
    const continueAfterToolBoundaryPromise = new Promise<void>((resolve) => {
      continueAfterToolBoundary = resolve;
    });
    let toolBoundarySeen!: () => void;
    const toolBoundarySeenPromise = new Promise<void>((resolve) => {
      toolBoundarySeen = resolve;
    });

    const harness = createExecutorHarness({
      sessionSource: "web",
      customGenerate: async (input) => {
        await input.onTextDelta?.("稍等");
        await input.onProviderResponseComplete?.({
          phase: "tool_call",
          text: "稍等",
          toolCalls: [{
            id: "call_lookup_1",
            type: "function",
            function: {
              name: "lookup",
              arguments: "{}"
            }
          }]
        });
        await input.onAssistantToolCalls?.({
          role: "assistant",
          content: "稍等",
          tool_calls: [{
            id: "call_lookup_1",
            type: "function",
            function: {
              name: "lookup",
              arguments: "{}"
            }
          }]
        });
        toolBoundarySeen();
        await continueAfterToolBoundaryPromise;
        await input.onTextDelta?.("查完了。");
        return {
          text: "查完了。",
          reasoningContent: "",
          usage: createUsage()
        };
      }
    });

    await toolBoundarySeenPromise;
    await waitForEvents(harness.events, 1);
    assert.deepEqual(harness.events, ["send:稍等"]);

    continueAfterToolBoundary();
    await waitForEvents(harness.events, 2);
    assert.deepEqual(harness.events, ["send:稍等", "send:查完了。"]);

    harness.resolveDrain();
    await harness.runPromise;
  });

  test("default web titles are captioned only after outbound drain completes", async () => {
    const harness = createExecutorHarness({
      sessionSource: "web",
      titleSource: "default",
      onGenerateTitle: async () => "自动标题"
    });

    await waitForEvents(harness.events, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(harness.events, ["send:你好"]);

    harness.resolveDrain();
    await harness.runPromise;
    await waitForCondition(
      () => harness.sessionManager.getSession(harness.sessionId).title === "自动标题",
      "Timed out waiting for default web title caption"
    );

    assert.deepEqual(harness.events, ["send:你好", "title:generate"]);
    assert.equal(harness.sessionManager.getSession(harness.sessionId).title, "自动标题");
    assert.equal(harness.sessionManager.getSession(harness.sessionId).titleSource, "auto");
  });

  test("compression forces title regeneration for auto-titled web sessions after turn completion", async () => {
    const harness = createExecutorHarness({
      sessionSource: "web",
      titleSource: "auto",
      historyCompressed: true,
      onGenerateTitle: async () => "压缩后标题"
    });

    harness.resolveDrain();
    await harness.runPromise;
    await waitForCondition(
      () => harness.sessionManager.getSession(harness.sessionId).title === "压缩后标题",
      "Timed out waiting for compressed web title caption"
    );

    assert.deepEqual(harness.events, ["send:你好", "history:compressed", "title:generate"]);
    assert.equal(harness.sessionManager.getSession(harness.sessionId).title, "压缩后标题");
    assert.equal(harness.sessionManager.getSession(harness.sessionId).titleSource, "auto");
  });

  test("manual web titles are never auto-regenerated even when forced", async () => {
    const harness = createExecutorHarness({
      sessionSource: "web",
      titleSource: "manual",
      forceRegenerateTitleAfterTurn: true,
      onGenerateTitle: async () => "不该出现"
    });

    harness.resolveDrain();
    await harness.runPromise;
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(harness.events, ["send:你好"]);
    assert.equal(harness.sessionManager.getSession(harness.sessionId).title, "New Chat");
    assert.equal(harness.sessionManager.getSession(harness.sessionId).titleSource, "manual");
  });

  test("persisted tool result transcript items include compact observation metadata", async () => {
    const rawToolContent = JSON.stringify({
      path: "src/app/generation/providerTranscriptProjector.ts",
      content: Array.from({ length: 120 }, (_, index) => `RAW-${index + 1}`).join("\n"),
      startLine: 1,
      endLine: 120,
      totalLines: 300,
      truncated: true
    });
    const harness = createExecutorHarness({
      sessionSource: "web",
      customGenerate: async (input) => {
        await input.onAssistantToolCalls?.({
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "call_read_1",
            type: "function",
            function: {
              name: "local_file_read",
              arguments: "{\"path\":\"src/app/generation/providerTranscriptProjector.ts\"}"
            }
          }]
        });
        await input.onToolResultMessage?.({
          role: "tool",
          tool_call_id: "call_read_1",
          content: rawToolContent
        }, "local_file_read");
        await input.onTextDelta?.("读完了。");
        return {
          text: "读完了。",
          reasoningContent: "",
          usage: createUsage()
        };
      }
    });

    harness.resolveDrain();
    await harness.runPromise;

    const toolResult = harness.sessionManager
      .getSession(harness.sessionId)
      .internalTranscript
      .find((item) => item.kind === "tool_result");

    assert.equal(toolResult?.kind, "tool_result");
    assert.equal(toolResult?.content, rawToolContent);
    assert.equal(toolResult?.observation?.resource?.kind, "local_file");
    assert.equal(toolResult?.observation?.resource?.id, "src/app/generation/providerTranscriptProjector.ts");
    assert.match(toolResult?.observation?.replayContent ?? "", /"compacted":true/);
  });
