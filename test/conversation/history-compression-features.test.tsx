import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { HistoryCompressor } from "../../src/conversation/historyCompressor.ts";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

function createConfig() {
  return createTestAppConfig({
    conversation: {
      historyCompression: {
        enabled: true
      }
    },
    llm: {
      enabled: true,
      providers: {},
      toolCallMaxIterations: 4,
      routingPresets: {
        test: {
          historyWindow: {
            maxRecentMessages: 20
          }
        }
      },
      summarizer: {
        enabled: true
      }
    }
  });
}

function appendSimpleHistory(
  sessionManager: SessionManager,
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  timestampMs: number
): void {
  if (role === "user") {
    sessionManager.appendUserHistory(sessionId, {
      chatType: "private",
      userId: "tester",
      senderName: "tester",
      text: content
    }, timestampMs);
    return;
  }

  sessionManager.appendAssistantHistory(sessionId, {
    chatType: "private",
    userId: "assistant",
    senderName: "assistant",
    text: content
  }, timestampMs);
}

  test("forceCompact uses default retain count from config", async () => {
    const sessionManager = new SessionManager(createConfig());
    sessionManager.ensureSession({ id: "qqbot:p:test", type: "private" });
    appendSimpleHistory(sessionManager, "qqbot:p:test", "user", "hello", 1);
    appendSimpleHistory(sessionManager, "qqbot:p:test", "assistant", "hi", 2);
    appendSimpleHistory(sessionManager, "qqbot:p:test", "user", "more", 3);
    appendSimpleHistory(sessionManager, "qqbot:p:test", "assistant", "later", 4);
    let capturedMessages: Array<{ content?: unknown }> | null = null;

    const compressor = new HistoryCompressor(
      createConfig(),
      {
        isConfigured() {
          return true;
        },
        async generate(input: { messages: Array<{ content?: unknown }> }) {
          capturedMessages = input.messages;
          return {
            text: "compressed summary",
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              totalTokens: 2,
              reasoningTokens: null,
              cachedTokens: null,
              requestCount: 1,
              providerReported: true,
              modelRef: "main",
              model: "fake"
            }
          };
        }
      } as any,
      sessionManager,
      {
        async ensureReady() {
          return new Map();
        }
      } as any,
      pino({ level: "silent" })
    );

    const changed = await compressor.forceCompact("qqbot:p:test");
    const session = sessionManager.getSession("qqbot:p:test");
    const llmVisibleHistory = sessionManager.getLlmVisibleHistory("qqbot:p:test");

    assert.equal(changed, true);
    assert.equal(session.historySummary, "compressed summary");
    assert.deepEqual(
      llmVisibleHistory.map((message) => message.content),
      ["hi", "more", "later"]
    );
    assert.deepEqual(
      session.internalTranscript.map((item) => item.kind === "user_message" || item.kind === "assistant_message" ? item.text : item.kind),
      ["hi", "more", "later"]
    );
    const captured = (capturedMessages ?? []) as Array<{ content?: unknown }>;
    const systemPrompt = String(captured[0]?.content ?? "");
    const userPrompt = String(captured[1]?.content ?? "");
    assert.match(systemPrompt, /必须保留：稳定/);
    assert.match(systemPrompt, /未完成\/等待触发事项必须继续保留/);
    assert.match(systemPrompt, /条件触发承诺/);
    assert.match(systemPrompt, /第一人称工作状态与记忆/);
    assert.match(systemPrompt, /工具\/资源线索/);
    assert.match(systemPrompt, /拒绝流水账式的复述/);
    assert.match(systemPrompt, /优先控制在 8~12 句/);
    assert.match(userPrompt, /summary_context/);
  });

  test("successful compression clears stale last LLM usage", async () => {
    const sessionManager = new SessionManager(createConfig());
    sessionManager.ensureSession({ id: "qqbot:p:test", type: "private" });
    appendSimpleHistory(sessionManager, "qqbot:p:test", "user", "hello", 1);
    appendSimpleHistory(sessionManager, "qqbot:p:test", "assistant", "hi", 2);
    appendSimpleHistory(sessionManager, "qqbot:p:test", "user", "more", 3);
    const epoch = sessionManager.getMutationEpoch("qqbot:p:test");
    assert.equal(sessionManager.setLastLlmUsageIfEpochMatches("qqbot:p:test", epoch, {
      inputTokens: 10000,
      outputTokens: 1,
      totalTokens: 10001,
      reasoningTokens: null,
      cachedTokens: null,
      requestCount: 1,
      providerReported: true,
      modelRef: "main",
      model: "fake",
      capturedAt: 4
    }), true);

    const compressor = new HistoryCompressor(
      createConfig(),
      {
        isConfigured() {
          return true;
        },
        async generate() {
          return {
            text: "compressed summary",
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              totalTokens: 2,
              reasoningTokens: null,
              cachedTokens: null,
              requestCount: 1,
              providerReported: true,
              modelRef: "summarizer",
              model: "fake"
            }
          };
        }
      } as any,
      sessionManager,
      {
        async ensureReady() {
          return new Map();
        }
      } as any,
      pino({ level: "silent" })
    );

    assert.equal(await compressor.forceCompact("qqbot:p:test", 1), true);
    assert.equal(sessionManager.getSession("qqbot:p:test").lastLlmUsage, null);
  });

  test("maybeCompress skips repeated unchanged below-threshold token checks", async () => {
    const sessionManager = new SessionManager(createConfig());
    sessionManager.ensureSession({ id: "qqbot:p:test", type: "private" });
    appendSimpleHistory(sessionManager, "qqbot:p:test", "user", "hello", 1);
    let snapshotChecks = 0;
    const originalGetSnapshot = sessionManager.getHistoryForCompressionByTokens.bind(sessionManager);
    sessionManager.getHistoryForCompressionByTokens = ((...args: Parameters<typeof originalGetSnapshot>) => {
      snapshotChecks += 1;
      return originalGetSnapshot(...args);
    }) as typeof sessionManager.getHistoryForCompressionByTokens;

    const compressor = new HistoryCompressor(
      createConfig(),
      {
        isConfigured() {
          return true;
        },
        async generate() {
          throw new Error("should not summarize below threshold");
        }
      } as any,
      sessionManager,
      {
        async ensureReady() {
          return new Map();
        }
      } as any,
      pino({ level: "silent" })
    );

    assert.equal(await compressor.maybeCompress("qqbot:p:test"), false);
    assert.equal(await compressor.maybeCompress("qqbot:p:test"), false);
    assert.equal(snapshotChecks, 1);
  });

  test("token compression still triggers when reported usage is stale below threshold", () => {
    const sessionManager = new SessionManager(createConfig());
    const sessionId = "qqbot:p:test";
    sessionManager.ensureSession({ id: sessionId, type: "private" });
    appendSimpleHistory(sessionManager, sessionId, "user", "x".repeat(1200), 1);
    appendSimpleHistory(sessionManager, sessionId, "assistant", "y".repeat(1200), 2);

    const snapshot = sessionManager.getHistoryForCompressionByTokens(sessionId, 500, 50, 1);

    assert.ok(snapshot);
    assert.equal(snapshot.tokenBudget.source, "estimated_with_provider_floor");
    assert.ok(snapshot.totalTokens > 500);
    assert.ok(snapshot.estimatedTotalTokens > 500);
  });

  test("token compression uses provider usage as a floor when estimate is lower", () => {
    const sessionManager = new SessionManager(createConfig());
    const sessionId = "qqbot:p:test";
    sessionManager.ensureSession({ id: sessionId, type: "private" });
    for (let index = 0; index < 8; index += 1) {
      appendSimpleHistory(sessionManager, sessionId, index % 2 === 0 ? "user" : "assistant", "z".repeat(350), index + 1);
    }

    const snapshot = sessionManager.getHistoryForCompressionByTokens(sessionId, 5000, 100, 6000);

    assert.ok(snapshot);
    assert.equal(snapshot.totalTokens, 6000);
    assert.ok(snapshot.estimatedTotalTokens < 5000);
  });

  test("token compression ignores cumulative provider usage as prompt floor", () => {
    const sessionManager = new SessionManager(createConfig());
    const sessionId = "qqbot:p:test";
    sessionManager.ensureSession({ id: sessionId, type: "private" });
    appendSimpleHistory(sessionManager, sessionId, "user", "short", 1);
    const epoch = sessionManager.getMutationEpoch(sessionId);
    sessionManager.setLastLlmUsageIfEpochMatches(sessionId, epoch, {
      inputTokens: 6000,
      outputTokens: 20,
      totalTokens: 6020,
      reasoningTokens: null,
      cachedTokens: null,
      requestCount: 3,
      providerReported: true,
      modelRef: "main",
      model: "fake",
      capturedAt: 2
    });

    const snapshot = sessionManager.getHistoryForCompressionByTokens(
      sessionId,
      5000,
      100,
      sessionManager.getLastLlmUsage(sessionId)?.requestCount === 1
        ? sessionManager.getLastLlmUsage(sessionId)?.inputTokens ?? undefined
        : undefined
    );

    assert.equal(snapshot, null);
  });

  test("token compression skips when only fixed prompt overhead exceeds the trigger", () => {
    const sessionManager = new SessionManager(createConfig());
    const sessionId = "qqbot:p:test";
    sessionManager.ensureSession({ id: sessionId, type: "private" });
    appendSimpleHistory(sessionManager, sessionId, "user", "short", 1);

    const snapshot = sessionManager.getHistoryForCompressionByTokens(sessionId, 100, 1000);

    assert.equal(snapshot, null);
  });

  test("token compression keeps the newest oversized message raw", () => {
    const sessionManager = new SessionManager(createConfig());
    const sessionId = "qqbot:p:test";
    sessionManager.ensureSession({ id: sessionId, type: "private" });
    appendSimpleHistory(sessionManager, sessionId, "user", "old".repeat(300), 1);
    appendSimpleHistory(sessionManager, sessionId, "assistant", "middle".repeat(300), 2);
    appendSimpleHistory(sessionManager, sessionId, "user", "latest".repeat(1000), 3);

    const snapshot = sessionManager.getHistoryForCompressionByTokens(sessionId, 500, 10);

    assert.ok(snapshot);
    assert.deepEqual(snapshot.retainedMessages.map((message) => message.content), ["latest".repeat(1000)]);
  });

  test("token compression counts old tool observations as reclaimable context", () => {
    const sessionManager = new SessionManager(createConfig());
    const sessionId = "qqbot:p:test";
    sessionManager.ensureSession({ id: sessionId, type: "private" });
    appendSimpleHistory(sessionManager, sessionId, "user", "old question", 1);
    sessionManager.appendInternalTranscript(sessionId, {
      kind: "assistant_tool_call",
      llmVisible: true,
      timestampMs: 2,
      content: "",
      toolCalls: [{
        id: "tool-1",
        type: "function",
        function: {
          name: "filesystem_read",
          arguments: "{\"path\":\"large.txt\"}"
        }
      }]
    });
    sessionManager.appendInternalTranscript(sessionId, {
      kind: "tool_result",
      llmVisible: true,
      timestampMs: 3,
      toolCallId: "tool-1",
      toolName: "filesystem_read",
      content: "raw".repeat(1000),
      observation: {
        contentHash: "hash-1",
        inputTokensEstimate: 1200,
        summary: "读取 large.txt 得到大量内容",
        retention: "summary",
        replayContent: "{\"compacted\":true}",
        replaySafe: true,
        refetchable: true,
        pinned: false
      }
    });
    appendSimpleHistory(sessionManager, sessionId, "assistant", "new answer", 4);

    const snapshot = sessionManager.getHistoryForCompressionByTokens(sessionId, 500, 20);

    assert.ok(snapshot);
    assert.ok(snapshot.tokenBudget.toolReplayTokens >= 1200);
    assert.equal(snapshot.toolObservationsToCompress.length, 1);
    assert.equal(snapshot.toolObservationsToCompress[0]?.toolCallId, "tool-1");
  });

  test("forceCompact accepts explicit zero retained history items", async () => {
    const sessionManager = new SessionManager(createConfig());
    sessionManager.ensureSession({ id: "qqbot:p:test", type: "private" });
    appendSimpleHistory(sessionManager, "qqbot:p:test", "user", "hello", 1);
    appendSimpleHistory(sessionManager, "qqbot:p:test", "assistant", "hi", 2);
    appendSimpleHistory(sessionManager, "qqbot:p:test", "user", "more", 3);

    const compressor = new HistoryCompressor(
      createConfig(),
      {
        isConfigured() {
          return true;
        },
        async generate() {
          return {
            text: "compressed summary",
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              totalTokens: 2,
              reasoningTokens: null,
              cachedTokens: null,
              requestCount: 1,
              providerReported: true,
              modelRef: "main",
              model: "fake"
            }
          };
        }
      } as any,
      sessionManager,
      {
        async ensureReady() {
          return new Map();
        }
      } as any,
      pino({ level: "silent" })
    );

    const changed = await compressor.forceCompact("qqbot:p:test", 0);
    const session = sessionManager.getSession("qqbot:p:test");
    const llmVisibleHistory = sessionManager.getLlmVisibleHistory("qqbot:p:test");

    assert.equal(changed, true);
    assert.equal(session.historySummary, "compressed summary");
    assert.deepEqual(llmVisibleHistory, []);
    assert.deepEqual(session.internalTranscript, []);
  });

  test("compactOldHistoryKeepingRecent preserves the latest topic window", async () => {
    const sessionManager = new SessionManager(createConfig());
    sessionManager.ensureSession({ id: "qqbot:p:test", type: "private" });
    appendSimpleHistory(sessionManager, "qqbot:p:test", "user", "old-1", 1);
    sessionManager.appendInternalTranscript("qqbot:p:test", {
      kind: "status_message",
      llmVisible: false,
      role: "assistant",
      statusType: "system",
      content: "old-status",
      timestampMs: 1
    });
    appendSimpleHistory(sessionManager, "qqbot:p:test", "assistant", "old-2", 2);
    appendSimpleHistory(sessionManager, "qqbot:p:test", "user", "new-1", 3);
    sessionManager.appendInternalTranscript("qqbot:p:test", {
      kind: "status_message",
      llmVisible: false,
      role: "assistant",
      statusType: "system",
      content: "new-status",
      timestampMs: 3
    });
    appendSimpleHistory(sessionManager, "qqbot:p:test", "assistant", "new-2", 4);

    const compressor = new HistoryCompressor(
      createConfig(),
      {
        isConfigured() {
          return true;
        },
        async generate() {
          return {
            text: "compressed summary",
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              totalTokens: 2,
              reasoningTokens: null,
              cachedTokens: null,
              requestCount: 1,
              providerReported: true,
              modelRef: "main",
              model: "fake"
            }
          };
        }
      } as any,
      sessionManager,
      {
        async ensureReady() {
          return new Map();
        }
      } as any,
      pino({ level: "silent" })
    );

    const changed = await compressor.compactOldHistoryKeepingRecent("qqbot:p:test", 2);
    const session = sessionManager.getSession("qqbot:p:test");
    const llmVisibleHistory = sessionManager.getLlmVisibleHistory("qqbot:p:test");

    assert.equal(changed, true);
    assert.equal(session.historySummary, "compressed summary");
    assert.deepEqual(
      llmVisibleHistory.map((message) => message.content),
      ["new-1", "new-2"]
    );
    assert.deepEqual(
      session.internalTranscript.map((item) => item.kind === "status_message" ? item.content : item.kind),
      ["user_message", "new-status", "assistant_message"]
    );
  });

  test("compression also absorbs leading tool items from retained window", async () => {
    const sessionManager = new SessionManager(createConfig());
    sessionManager.ensureSession({ id: "qqbot:p:test", type: "private" });
    appendSimpleHistory(sessionManager, "qqbot:p:test", "user", "old-1", 1);
    sessionManager.appendInternalTranscript("qqbot:p:test", {
      kind: "assistant_tool_call",
      llmVisible: true,
      timestampMs: 2,
      content: "tool call",
      toolCalls: [{
        id: "tool-1",
        type: "function",
        function: {
          name: "search",
          arguments: "{}"
        }
      }]
    });
    sessionManager.appendInternalTranscript("qqbot:p:test", {
      kind: "tool_result",
      llmVisible: true,
      timestampMs: 3,
      toolCallId: "tool-1",
      toolName: "search",
      content: "tool result"
    });
    appendSimpleHistory(sessionManager, "qqbot:p:test", "assistant", "old-2", 4);
    appendSimpleHistory(sessionManager, "qqbot:p:test", "user", "new-1", 5);
    appendSimpleHistory(sessionManager, "qqbot:p:test", "assistant", "new-2", 6);

    const compressor = new HistoryCompressor(
      createConfig(),
      {
        isConfigured() {
          return true;
        },
        async generate() {
          return {
            text: "compressed summary",
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              totalTokens: 2,
              reasoningTokens: null,
              cachedTokens: null,
              requestCount: 1,
              providerReported: true,
              modelRef: "main",
              model: "fake"
            }
          };
        }
      } as any,
      sessionManager,
      {
        async ensureReady() {
          return new Map();
        }
      } as any,
      pino({ level: "silent" })
    );

    const changed = await compressor.compactOldHistoryKeepingRecent("qqbot:p:test", 3);
    const session = sessionManager.getSession("qqbot:p:test");
    const llmVisibleHistory = sessionManager.getLlmVisibleHistory("qqbot:p:test");

    assert.equal(changed, true);
    assert.equal(session.historySummary, "compressed summary");
    assert.deepEqual(
      llmVisibleHistory.map((message) => message.content),
      ["old-2", "new-1", "new-2"]
    );
    assert.deepEqual(
      session.internalTranscript.map((item) => item.kind === "user_message" || item.kind === "assistant_message" ? item.text : item.kind),
      ["old-2", "new-1", "new-2"]
    );
  });

  test("compression materializes pinned and failed tool evidence before transcript trimming", async () => {
    const config = createConfig();
    const sessionManager = new SessionManager(config);
    const sessionId = "qqbot:p:test";
    sessionManager.ensureSession({ id: sessionId, type: "private" });
    sessionManager.setTaskTracker(sessionId, {
      version: 1,
      primary: {
        taskId: "task-1",
        status: "active",
        objective: "保留压缩前证据",
        done: [],
        next: [],
        blockers: [],
        importantToolRefs: [{
          toolCallId: "tool-pinned",
          toolName: "terminal_run",
          summary: "关键终端输出",
          createdAtMs: 1
        }],
        createdAtMs: 1,
        updatedAtMs: 1
      },
      parked: [],
      evidence: []
    });
    appendSimpleHistory(sessionManager, sessionId, "user", "old request", 1);
    sessionManager.appendInternalTranscript(sessionId, {
      kind: "assistant_tool_call",
      llmVisible: true,
      timestampMs: 2,
      content: "tool call",
      toolCalls: [{
        id: "tool-pinned",
        type: "function",
        function: {
          name: "terminal_run",
          arguments: "{\"cmd\":\"npm test\"}"
        }
      }]
    });
    sessionManager.appendInternalTranscript(sessionId, {
      kind: "tool_result",
      llmVisible: true,
      timestampMs: 3,
      toolCallId: "tool-pinned",
      toolName: "terminal_run",
      content: "{\"output\":\"fail\",\"exitCode\":2}",
      canonicalContent: JSON.stringify({ output: "fail", exitCode: 2, stderr: "failed assertion" }),
      observation: {
        contentHash: "hash-pinned",
        inputTokensEstimate: 12,
        summary: "npm test 失败，退出码 2",
        retention: "summary",
        replayContent: "{\"exitCode\":2,\"summary\":\"npm test failed\"}",
        replaySafe: true,
        refetchable: false,
        pinned: true
      }
    });
    appendSimpleHistory(sessionManager, sessionId, "assistant", "old answer", 4);

    const compressor = new HistoryCompressor(
      config,
      {
        isConfigured() {
          return true;
        },
        async generate() {
          return {
            text: "compressed summary",
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              totalTokens: 2,
              reasoningTokens: null,
              cachedTokens: null,
              requestCount: 1,
              providerReported: true,
              modelRef: "main",
              model: "fake"
            }
          };
        }
      } as any,
      sessionManager,
      {
        async ensureReady() {
          return new Map();
        }
      } as any,
      pino({ level: "silent" })
    );

    assert.equal(await compressor.forceCompact(sessionId, 0), true);
    const session = sessionManager.getSession(sessionId);
    assert.deepEqual(session.internalTranscript, []);
    assert.equal(session.taskTracker.evidence.length, 1);
    assert.equal(session.taskTracker.evidence[0]?.toolCallId, "tool-pinned");
    assert.equal(session.taskTracker.evidence[0]?.pinned, true);
    assert.match(session.taskTracker.evidence[0]?.canonicalContent ?? "", /failed assertion/);
    assert.match(session.taskTracker.evidence[0]?.replayContent ?? "", /npm test failed/);
  });

  test("compression evidence avoids canonical copy for ordinary refetchable large results", async () => {
    const config = createConfig();
    const sessionManager = new SessionManager(config);
    const sessionId = "qqbot:p:test";
    sessionManager.ensureSession({ id: sessionId, type: "private" });
    sessionManager.setTaskTracker(sessionId, {
      version: 1,
      primary: {
        taskId: "task-1",
        status: "active",
        objective: "搜索资料",
        done: [],
        next: [],
        blockers: [],
        importantToolRefs: [{
          toolCallId: "tool-search",
          toolName: "web_search",
          resource: { kind: "search_result", id: "search-1" },
          createdAtMs: 1
        }],
        createdAtMs: 1,
        updatedAtMs: 1
      },
      parked: [],
      evidence: []
    });
    appendSimpleHistory(sessionManager, sessionId, "user", "old request", 1);
    const largeCanonical = JSON.stringify({
      results: Array.from({ length: 20 }, (_, index) => ({
        title: `Result ${index}`,
        snippet: "LARGE_CANONICAL_SHOULD_NOT_BE_COPIED".repeat(100)
      }))
    });
    sessionManager.appendInternalTranscript(sessionId, {
      kind: "tool_result",
      llmVisible: true,
      timestampMs: 2,
      toolCallId: "tool-search",
      toolName: "web_search",
      content: "{\"results\":20}",
      canonicalContent: largeCanonical,
      observation: {
        contentHash: "hash-search",
        inputTokensEstimate: 4000,
        summary: "搜索返回 20 条结果",
        retention: "summary",
        replayContent: "{\"tool\":\"web_search\",\"summary\":\"20 results\",\"resource\":{\"kind\":\"search_result\",\"id\":\"search-1\"}}",
        resource: { kind: "search_result", id: "search-1" },
        replaySafe: true,
        refetchable: true,
        pinned: false
      }
    });
    appendSimpleHistory(sessionManager, sessionId, "assistant", "old answer", 3);

    let capturedMessages: Array<{ content?: unknown }> = [];
    const compressor = new HistoryCompressor(
      config,
      {
        isConfigured() {
          return true;
        },
        async generate(input: { messages: Array<{ content?: unknown }> }) {
          capturedMessages = input.messages;
          return {
            text: "compressed summary",
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              totalTokens: 2,
              reasoningTokens: null,
              cachedTokens: null,
              requestCount: 1,
              providerReported: true,
              modelRef: "main",
              model: "fake"
            }
          };
        }
      } as any,
      sessionManager,
      {
        async ensureReady() {
          return new Map();
        }
      } as any,
      pino({ level: "silent" })
    );

    assert.equal(await compressor.forceCompact(sessionId, 0), true);
    const evidence = sessionManager.getSession(sessionId).taskTracker.evidence[0];
    assert.equal(evidence?.toolCallId, "tool-search");
    assert.equal(evidence?.canonicalContent, undefined);
    assert.deepEqual(evidence?.resource, { kind: "search_result", id: "search-1" });
    assert.match(evidence?.replayContent ?? "", /20 results/);
    assert.doesNotMatch(JSON.stringify(evidence), /LARGE_CANONICAL_SHOULD_NOT_BE_COPIED/);
    assert.doesNotMatch(JSON.stringify(capturedMessages), /LARGE_CANONICAL_SHOULD_NOT_BE_COPIED/);
  });

  test("compression keeps retained window unchanged when it already starts with a normal message", async () => {
    const sessionManager = new SessionManager(createConfig());
    sessionManager.ensureSession({ id: "qqbot:p:test", type: "private" });
    appendSimpleHistory(sessionManager, "qqbot:p:test", "user", "old-1", 1);
    sessionManager.appendInternalTranscript("qqbot:p:test", {
      kind: "assistant_tool_call",
      llmVisible: true,
      timestampMs: 2,
      content: "tool call",
      toolCalls: [{
        id: "tool-1",
        type: "function",
        function: {
          name: "search",
          arguments: "{}"
        }
      }]
    });
    sessionManager.appendInternalTranscript("qqbot:p:test", {
      kind: "tool_result",
      llmVisible: true,
      timestampMs: 3,
      toolCallId: "tool-1",
      toolName: "search",
      content: "tool result"
    });
    appendSimpleHistory(sessionManager, "qqbot:p:test", "assistant", "old-2", 4);
    appendSimpleHistory(sessionManager, "qqbot:p:test", "user", "new-1", 5);
    appendSimpleHistory(sessionManager, "qqbot:p:test", "assistant", "new-2", 6);

    const compressor = new HistoryCompressor(
      createConfig(),
      {
        isConfigured() {
          return true;
        },
        async generate() {
          return {
            text: "compressed summary",
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              totalTokens: 2,
              reasoningTokens: null,
              cachedTokens: null,
              requestCount: 1,
              providerReported: true,
              modelRef: "main",
              model: "fake"
            }
          };
        }
      } as any,
      sessionManager,
      {
        async ensureReady() {
          return new Map();
        }
      } as any,
      pino({ level: "silent" })
    );

    const changed = await compressor.compactOldHistoryKeepingRecent("qqbot:p:test", 2);
    const session = sessionManager.getSession("qqbot:p:test");
    const llmVisibleHistory = sessionManager.getLlmVisibleHistory("qqbot:p:test");

    assert.equal(changed, true);
    assert.equal(session.historySummary, "compressed summary");
    assert.deepEqual(
      llmVisibleHistory.map((message) => message.content),
      ["new-1", "new-2"]
    );
    assert.deepEqual(
      session.internalTranscript.map((item) => {
        if (item.kind === "user_message" || item.kind === "assistant_message") {
          return item.text;
        }
        return item.kind;
      }),
      ["new-1", "new-2"]
    );
  });

  test("stale epoch writes are rejected after clear", async () => {
    const sessionManager = new SessionManager(createConfig());
    sessionManager.ensureSession({ id: "qqbot:p:test", type: "private" });
    appendSimpleHistory(sessionManager, "qqbot:p:test", "user", "before", 1);

    const oldEpoch = sessionManager.getMutationEpoch("qqbot:p:test");
    sessionManager.clearSession("qqbot:p:test");

    assert.equal(
      sessionManager.appendInternalTranscriptIfEpochMatches("qqbot:p:test", oldEpoch, {
        kind: "status_message",
        llmVisible: false,
        role: "assistant",
        statusType: "system",
        content: "stale",
        timestampMs: 2
      }),
      false
    );
    assert.equal(
      sessionManager.setLastLlmUsageIfEpochMatches("qqbot:p:test", oldEpoch, {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        reasoningTokens: null,
        cachedTokens: null,
        requestCount: 1,
        providerReported: true,
        modelRef: "main",
        model: "fake",
        capturedAt: 3
      }),
      false
    );

    const session = sessionManager.getSession("qqbot:p:test");
    const llmVisibleHistory = sessionManager.getLlmVisibleHistory("qqbot:p:test");
    assert.equal(session.historySummary, null);
    assert.deepEqual(llmVisibleHistory, []);
    assert.equal(session.lastLlmUsage, null);
  });

  test("compression results are rejected when history changes during summarization", async () => {
    const sessionManager = new SessionManager(createConfig());
    sessionManager.ensureSession({ id: "qqbot:p:test", type: "private" });
    appendSimpleHistory(sessionManager, "qqbot:p:test", "user", "hello", 1);
    appendSimpleHistory(sessionManager, "qqbot:p:test", "assistant", "hi", 2);
    appendSimpleHistory(sessionManager, "qqbot:p:test", "user", "more", 3);

    let releaseSummary!: () => void;
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    const compressor = new HistoryCompressor(
      createConfig(),
      {
        isConfigured() {
          return true;
        },
        async generate() {
          await summaryGate;
          return {
            text: "compressed summary",
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              totalTokens: 2,
              reasoningTokens: null,
              cachedTokens: null,
              requestCount: 1,
              providerReported: true,
              modelRef: "main",
              model: "fake"
            }
          };
        }
      } as any,
      sessionManager,
      {
        async ensureReady() {
          return new Map();
        }
      } as any,
      pino({ level: "silent" })
    );

    const pendingCompression = compressor.forceCompact("qqbot:p:test");
    appendSimpleHistory(sessionManager, "qqbot:p:test", "user", "new info", 4);
    releaseSummary();

    const changed = await pendingCompression;
    const session = sessionManager.getSession("qqbot:p:test");
    const llmVisibleHistory = sessionManager.getLlmVisibleHistory("qqbot:p:test");

    assert.equal(changed, false);
    assert.equal(session.historySummary, null);
    assert.deepEqual(
      llmVisibleHistory.map((message) => message.content),
      ["hello", "hi", "more", "new info"]
    );
  });
