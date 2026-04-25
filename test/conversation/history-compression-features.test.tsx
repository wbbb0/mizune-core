import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { HistoryCompressor } from "../../src/conversation/historyCompressor.ts";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

function createConfig() {
  return createTestAppConfig({
    conversation: {
      historyWindow: {
        maxRecentMessages: 20
      },
      historyCompression: {
        enabled: true
      }
    },
    llm: {
      enabled: true,
      providers: {},
      toolCallMaxIterations: 4,
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
    assert.match(systemPrompt, /拒绝流水账式的复述/);
    assert.match(systemPrompt, /适度放长篇幅/);
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
