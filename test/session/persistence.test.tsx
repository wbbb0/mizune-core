import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { SessionPersistence } from "../../src/conversation/session/sessionPersistence.ts";
import type { PersistedSessionState } from "../../src/conversation/session/sessionManager.ts";
import { createSessionState, toPersistedSessionState } from "../../src/conversation/session/sessionStateFactory.ts";
import { clearSessionState } from "../../src/conversation/session/sessionMutations.ts";
import { createEmptyPersona } from "../../src/persona/personaSchema.ts";
import { createEmptyRpProfile } from "../../src/modes/rpAssistant/profileSchema.ts";

async function withDataDir(name: string, fn: (dataDir: string) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), `${name}-`));
  try {
    await fn(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("session persistence round-trips title titleSource and participantRef", async () => {
    const session = createSessionState({
      id: "web:test",
      type: "private",
      source: "web",
      participantRef: { kind: "user", id: "owner" },
      title: "New Chat",
      titleSource: "default"
    });

    const persisted = toPersistedSessionState(session);

    assert.deepEqual(persisted.participantRef, { kind: "user", id: "owner" });
    assert.equal(persisted.title, "New Chat");
    assert.equal(persisted.titleSource, "default");
    assert.ok(!("participantLabel" in persisted));
  assert.ok(!("participantUserId" in persisted));
});

test("session persistence stores operationMode drafts", async () => {
  await withDataDir("llm-bot-session-persist-operation-mode-test", async (dataDir: string) => {
    const persistence = new SessionPersistence(dataDir, pino({ level: "silent" }));
    await persistence.init();

    const session = createSessionState({
      id: "web:operation-mode",
      type: "private",
      source: "web",
      participantRef: { kind: "user", id: "owner" },
      title: "Operation Mode",
      titleSource: "manual"
    });
    session.operationMode = {
      kind: "mode_setup",
      modeId: "rp_assistant",
      draft: {
        ...createEmptyRpProfile(),
        selfPositioning: "Keeps a steady composure"
      }
    };

    const persisted = toPersistedSessionState(session);

    assert.deepEqual(persisted.operationMode, {
      kind: "mode_setup",
      modeId: "rp_assistant",
      draft: {
        ...createEmptyRpProfile(),
        selfPositioning: "Keeps a steady composure"
      }
    });

    await persistence.save(persisted);
    const [loaded] = await persistence.loadAll();
    assert.ok(loaded);
    assert.deepEqual(loaded.operationMode, persisted.operationMode);
  });
});

test("clearSessionState resets operationMode to normal", () => {
  const session = createSessionState({
    id: "web:clear-operation-mode",
    type: "private",
    source: "web",
    participantRef: { kind: "user", id: "owner" },
    title: "Clear Operation Mode",
    titleSource: "manual"
  });
  session.operationMode = {
    kind: "persona_config",
    draft: {
      ...createEmptyPersona(),
      name: "Draft Persona"
    }
  };

  clearSessionState(session);

  assert.deepEqual(session.operationMode, { kind: "normal" });
});

test("clearSessionState resets setupConfirmed", () => {
  const session = createSessionState({
    id: "web:clear-setup-confirmed",
    type: "private",
    source: "web",
    participantRef: { kind: "user", id: "owner" },
    title: "Clear Setup Confirmed",
    titleSource: "manual"
  });
  session.setupConfirmed = true;

  clearSessionState(session);

  assert.equal(session.setupConfirmed, false);
});

  test("session persistence round-trips current session shape", async () => {
    await withDataDir("llm-bot-session-persist-current-test", async (dataDir: string) => {
      const persistence = new SessionPersistence(dataDir, pino({ level: "silent" }));
      await persistence.init();

      const session: PersistedSessionState = {
        id: "qqbot:p:owner",
        type: "private",
        source: "onebot",
        modeId: "rp_assistant",
        operationMode: { kind: "normal" },
        participantRef: { kind: "user", id: "owner" },
        title: "Owner",
        titleSource: "manual",
        replyDelivery: "web",
        pendingMessages: [
          {
            userId: "owner",
            senderName: "Owner",
            chatType: "private",
            text: "hello",
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
            receivedAt: 1
          }
        ],
        historySummary: null,
        internalTranscript: [
          {
            kind: "user_message",
            role: "user",
            llmVisible: true,
            chatType: "private",
            userId: "owner",
            senderName: "Owner",
            text: "hello",
            imageIds: [],
            emojiIds: [],
            attachments: [],
            audioCount: 0,
            forwardIds: [],
            replyMessageId: null,
            mentionUserIds: [],
            mentionedAll: false,
            mentionedSelf: false,
            timestampMs: 1
          },
          {
            kind: "session_mode_switch",
            role: "assistant",
            llmVisible: true,
            fromModeId: "rp_assistant",
            toModeId: "rp_assistant",
            content: "⟦session_mode_switch from_mode=\"rp_assistant\" to_mode=\"rp_assistant\" timestamp=\"2026-04-14T00:00:00.000Z\"⟧",
            timestampMs: 2
          },
          {
            kind: "outbound_media_message",
            llmVisible: false,
            role: "assistant",
            delivery: "web",
            mediaKind: "image",
            fileId: "asset_img_1",
            fileRef: "img_hello.png",
            sourceName: "hello.png",
            chatFilePath: "workspace/media/asset_img_1.png",
            sourcePath: null,
            messageId: null,
            toolName: "chat_file_send_to_chat",
            captionText: null,
            timestampMs: 3
          },
          {
            kind: "fallback_event",
            llmVisible: false,
            timestampMs: 4,
            fallbackType: "model_candidate_switch",
            title: "模型切换 fallback",
            summary: "模型候选 main 请求失败，已切换到 backup",
            details: "Error: 503 Service Unavailable",
            fromModelRef: "main",
            toModelRef: "backup",
            fromProvider: "provider_a",
            toProvider: "provider_b"
          },
          {
            kind: "internal_trigger_event",
            llmVisible: false,
            timestampMs: 5,
            triggerKind: "scheduled_instruction",
            stage: "started",
            title: "内部触发器 · 开始执行",
            summary: "开始执行定时任务「daily」，目标 私聊 owner",
            jobName: "daily",
            targetType: "private",
            targetUserId: "owner",
            details: "提醒我喝水"
          }
        ],
        debugMarkers: [],
        recentToolEvents: [
          {
            toolName: "open_page",
            argsSummary: "{\"url\":\"https://example.com\"}",
            outcome: "success",
            resultSummary: "opened example page",
            timestampMs: 2
          }
        ],
        lastLlmUsage: {
          inputTokens: 12,
          outputTokens: 34,
          totalTokens: 46,
          cachedTokens: 5,
          reasoningTokens: null,
          requestCount: 1,
          providerReported: true,
          modelRef: "default",
          model: "test-model",
          capturedAt: 2
        },
        sentMessages: [],
        lastActiveAt: 1,
        lastMessageAt: 1,
        latestGapMs: null,
        smoothedGapMs: null
      };

      await persistence.save(session);
      assert.deepEqual(await persistence.loadAll(), [session]);
    });
  });

  test("session persistence keeps google replay metadata for assistant tool calls", async () => {
    await withDataDir("llm-bot-session-persist-google-tool-metadata-test", async (dataDir: string) => {
      const persistence = new SessionPersistence(dataDir, pino({ level: "silent" }));
      await persistence.init();

      const session: PersistedSessionState = {
        id: "qqbot:p:google-tool",
        type: "private",
        source: "onebot",
        modeId: "rp_assistant",
        operationMode: { kind: "normal" },
        participantRef: { kind: "user", id: "google-tool" },
        title: "google-tool",
        titleSource: "manual",
        replyDelivery: "onebot",
        pendingMessages: [],
        historySummary: null,
        internalTranscript: [{
          kind: "assistant_tool_call",
          llmVisible: true,
          timestampMs: 1,
          content: "",
          toolCalls: [{
            id: "tool-call-1",
            type: "function",
            function: {
              name: "open_page",
              arguments: "{\"url\":\"https://example.com\"}"
            },
            providerMetadata: {
              google: {
                thoughtSignature: "sig-1"
              }
            }
          }],
          providerMetadata: {
            googleParts: [{
              thoughtSignature: "sig-1",
              functionCall: {
                id: "tool-call-1",
                name: "open_page",
                args: {
                  url: "https://example.com"
                }
              }
            }]
          }
        }],
        debugMarkers: [],
        recentToolEvents: [],
        lastLlmUsage: null,
        sentMessages: [],
        lastActiveAt: 1,
        lastMessageAt: 1,
        latestGapMs: null,
        smoothedGapMs: null
      };

      await persistence.save(session);
      assert.deepEqual(await persistence.loadAll(), [session]);
    });
  });

  test("session persistence skips legacy session files missing current fields", async () => {
    await withDataDir("llm-bot-session-persist-legacy-test", async (dataDir: string) => {
      const persistence = new SessionPersistence(dataDir, pino({ level: "silent" }));
      await persistence.init();

      const filePath = join(dataDir, "sessions", `${encodeURIComponent("qqbot:p:legacy")}.json`);
      await writeFile(filePath, JSON.stringify({
        id: "qqbot:p:legacy",
        type: "private",
        pendingMessages: [
          {
            userId: "owner",
            senderName: "Owner",
            chatType: "private",
            text: "legacy",
            images: [],
            receivedAt: 1
          }
        ],
        historySummary: null,
        lastLlmUsage: {
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
          requestCount: 1,
          providerReported: true,
          modelRef: "legacy",
          model: "legacy-model",
          capturedAt: 2
        },
        lastActiveAt: 1,
        lastMessageAt: 1,
        latestGapMs: null,
        smoothedGapMs: null
      }, null, 2));

      assert.deepEqual(await persistence.loadAll(), []);
    });
  });

  test("session persistence loads usage snapshots without cached tokens as null", async () => {
    await withDataDir("llm-bot-session-persist-cached-tokens-compat-test", async (dataDir: string) => {
      const persistence = new SessionPersistence(dataDir, pino({ level: "silent" }));
      await persistence.init();

      const filePath = join(dataDir, "sessions", `${encodeURIComponent("qqbot:p:compat")}.json`);
      await writeFile(filePath, JSON.stringify({
        id: "qqbot:p:compat",
        type: "private",
        participantRef: {
          kind: "user",
          id: "compat"
        },
        title: "Compat",
        titleSource: "default",
        pendingMessages: [],
        historySummary: null,
        internalTranscript: [],
        debugMarkers: [],
        recentToolEvents: [],
        lastLlmUsage: {
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
          requestCount: 1,
          providerReported: true,
          modelRef: "compat",
          model: "compat-model",
          capturedAt: 2
        },
        sentMessages: [],
        lastActiveAt: 1,
        lastMessageAt: 1,
        latestGapMs: null,
        smoothedGapMs: null
      }, null, 2));

      assert.deepEqual(await persistence.loadAll(), [{
        id: "qqbot:p:compat",
        type: "private",
        source: "onebot",
        modeId: "rp_assistant",
        operationMode: { kind: "normal" },
        participantRef: {
          kind: "user",
          id: "compat"
        },
        title: "Compat",
        titleSource: "default",
        replyDelivery: "onebot",
        pendingMessages: [],
        historySummary: null,
        internalTranscript: [],
        debugMarkers: [],
        recentToolEvents: [],
        lastLlmUsage: {
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
          cachedTokens: null,
          reasoningTokens: null,
          requestCount: 1,
          providerReported: true,
          modelRef: "compat",
          model: "compat-model",
          capturedAt: 2
        },
        sentMessages: [],
        lastActiveAt: 1,
        lastMessageAt: 1,
        latestGapMs: null,
        smoothedGapMs: null
      }]);
    });
  });
