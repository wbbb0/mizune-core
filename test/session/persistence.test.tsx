import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { SessionPersistence } from "../../src/conversation/session/sessionPersistence.ts";
import type { PersistedSessionState } from "../../src/conversation/session/sessionManager.ts";
import { createSessionState, restoreSessionState, toPersistedSessionState } from "../../src/conversation/session/sessionStateFactory.ts";
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

test("session persistence does not resurrect a session when remove follows save", async () => {
  await withDataDir("llm-bot-session-persist-remove-after-save-test", async (dataDir: string) => {
    const persistence = new SessionPersistence(dataDir, pino({ level: "silent" }));
    await persistence.init();
    const session = toPersistedSessionState(createSessionState({
      id: "web:remove-after-save",
      type: "private",
      source: "web",
      participantRef: { kind: "user", id: "owner" },
      title: "Remove After Save",
      titleSource: "manual"
    }));

    await Promise.all([
      persistence.save(session),
      persistence.remove(session.id)
    ]);

    assert.deepEqual(await persistence.loadAll(), []);
  });
});

test("session persistence keeps a session when save follows remove", async () => {
  await withDataDir("llm-bot-session-persist-save-after-remove-test", async (dataDir: string) => {
    const persistence = new SessionPersistence(dataDir, pino({ level: "silent" }));
    await persistence.init();
    const first = toPersistedSessionState(createSessionState({
      id: "web:save-after-remove",
      type: "private",
      source: "web",
      participantRef: { kind: "user", id: "owner" },
      title: "Old",
      titleSource: "manual"
    }));
    const next = {
      ...first,
      title: "New",
      lastActiveAt: first.lastActiveAt + 1
    };
    await persistence.save(first);

    await Promise.all([
      persistence.remove(first.id),
      persistence.save(next)
    ]);

    const loaded = await persistence.loadAll();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.id, next.id);
    assert.equal(loaded[0]?.title, "New");
  });
});

test("session persistence writes sqlite storage without legacy json output", async () => {
  await withDataDir("llm-bot-session-persist-sqlite-only-test", async (dataDir: string) => {
    const persistence = new SessionPersistence(dataDir, pino({ level: "silent" }));
    await persistence.init();

    const session = toPersistedSessionState(createSessionState({
      id: "web:sqlite-only",
      type: "private",
      source: "web",
      participantRef: { kind: "user", id: "owner" },
      title: "SQLite Only",
      titleSource: "manual"
    }));

    await persistence.save(session);

    const sessionFiles = await readdir(join(dataDir, "sessions"), { withFileTypes: true });
    assert.equal(sessionFiles.some((entry) => entry.isFile() && entry.name.endsWith(".json")), false);
    assert.equal(sessionFiles.some((entry) => entry.isFile() && entry.name === "sessions.sqlite"), true);
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

test("session persistence loads legacy title_generation_event transcript items", async () => {
  await withDataDir("llm-bot-session-persist-title-event-test", async (dataDir: string) => {
    const persistence = new SessionPersistence(dataDir, pino({ level: "silent" }));
    await persistence.init();

    const session: PersistedSessionState = {
      id: "web:legacy-title-event",
      type: "private",
      source: "web",
      modeId: "assistant",
      operationMode: { kind: "normal" },
      participantRef: { kind: "user", id: "owner" },
      title: "角色设定",
      titleSource: "auto",
      replyDelivery: "web",
      pendingMessages: [],
      pendingTranscriptGroupId: null,
      activeTranscriptGroupId: null,
      historySummary: null,
      internalTranscript: [
        {
          kind: "title_generation_event",
          llmVisible: false,
          timestampMs: 10,
          source: "auto",
          modeId: "assistant",
          title: "标题生成 · 自动生成",
          summary: "角色设定",
          details: "sessionId: web:legacy-title-event\nmodeId: assistant\nhistorySummary: (none)\nhistoryCount: 3"
        }
      ],
      debugMarkers: [],
      lastLlmUsage: null,
      sentMessages: [],
      lastActiveAt: 10,
      lastMessageAt: 10,
      latestGapMs: null,
      smoothedGapMs: null
    };

    await persistence.save(session);

    assert.deepEqual(await persistence.loadAll(), [session]);
  });
});

test("session persistence round-trips asset attachments in pending messages and transcript", async () => {
  await withDataDir("llm-bot-session-persist-chat-file-attachments-test", async (dataDir: string) => {
    const persistence = new SessionPersistence(dataDir, pino({ level: "silent" }));
    await persistence.init();

    const session: PersistedSessionState = {
      id: "web:chat-file-attachments",
      type: "private",
      source: "web",
      modeId: "assistant",
      operationMode: { kind: "normal" },
      participantRef: { kind: "user", id: "owner" },
      title: "Chat File Attachments",
      titleSource: "manual",
      replyDelivery: "web",
      pendingMessages: [{
        userId: "owner",
        senderName: "Owner",
        chatType: "private",
        text: "带附件的消息",
        images: [],
        audioSources: [],
        audioIds: [],
        emojiSources: [],
        imageIds: [],
        emojiIds: [],
        attachments: [{
          fileId: "file_chat_1",
          kind: "file",
          source: "asset",
          sourceName: "memo.txt",
          mimeType: "text/plain"
        }],
        messageFiles: [],
        forwardIds: [],
        replyMessageId: null,
        mentionUserIds: [],
        mentionedAll: false,
        isAtMentioned: false,
        receivedAt: 1
      }],
      pendingTranscriptGroupId: null,
      activeTranscriptGroupId: null,
      historySummary: null,
      internalTranscript: [{
        kind: "user_message",
        role: "user",
        llmVisible: true,
        chatType: "private",
        userId: "owner",
        senderName: "Owner",
        text: "看这个文件",
        imageIds: [],
        emojiIds: [],
        attachments: [{
          fileId: "file_chat_1",
          kind: "file",
          source: "asset",
          sourceName: "memo.txt",
          mimeType: "text/plain"
        }],
        messageFiles: [],
        audioCount: 0,
        forwardIds: [],
        replyMessageId: null,
        mentionUserIds: [],
        mentionedAll: false,
        mentionedSelf: false,
        timestampMs: 1
      }],
      debugMarkers: [],
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

test("restoreSessionState normalizes transcript metadata for loaded sessions", () => {
  const restored = restoreSessionState({
    id: "web:normalize-transcript",
    type: "private",
    source: "web",
    modeId: "assistant",
    operationMode: { kind: "normal" },
    participantRef: { kind: "user", id: "owner" },
    title: "Normalize Transcript",
    titleSource: "manual",
    replyDelivery: "web",
    pendingMessages: [],
    pendingTranscriptGroupId: null,
    activeTranscriptGroupId: null,
    historySummary: null,
    internalTranscript: [{
      kind: "assistant_message",
      role: "assistant",
      llmVisible: true,
      chatType: "private",
      userId: "owner",
      senderName: "Owner",
      text: "hello",
      timestampMs: 1
    }],
    debugMarkers: [],
    lastLlmUsage: null,
    sentMessages: [],
    lastActiveAt: 1,
    lastMessageAt: 1,
    latestGapMs: null,
    smoothedGapMs: null
  });

  const item = restored.internalTranscript[0];
  assert.ok(item);
  assert.ok(item.id);
  assert.ok(item.groupId);
  assert.equal(item.runtimeExcluded, false);
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
            messageFiles: [],
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
            messageFiles: [],
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
            content: "<session_mode_switch from_mode=\"rp_assistant\" to_mode=\"rp_assistant\" timestamp=\"2026-04-14T00:00:00.000Z\"/>",
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
            toolName: "asset_send_to_chat",
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

  test("session persistence skips malformed sqlite rows missing current fields", async () => {
    await withDataDir("llm-bot-session-persist-legacy-test", async (dataDir: string) => {
      const persistence = new SessionPersistence(dataDir, pino({ level: "silent" }));
      await persistence.init();

      const db = await (persistence as any).getReadyDb();
      db.prepare(`
        INSERT INTO sessions (
          session_id, type, source, mode_id, operation_mode_json,
          participant_kind, participant_id, title, title_source, reply_delivery,
          pending_messages_json, pending_transcript_group_id, active_transcript_group_id,
          history_summary, history_backfill_boundary_ms, internal_transcript_json,
          debug_markers_json, last_llm_usage_json, sent_messages_json,
          last_active_at_ms, last_message_at_ms, latest_gap_ms, smoothed_gap_ms, updated_at_ms
        ) VALUES (
          'qqbot:p:legacy', 'private', NULL, NULL, NULL,
          'user', '', NULL, NULL, NULL,
          '[{"userId":"owner"}]', NULL, NULL,
          NULL, NULL, '[]',
          '[]', '{"inputTokens":10}', '[]',
          1, 1, NULL, NULL, 1
        )
      `).run();

      assert.deepEqual(await persistence.loadAll(), []);
    });
  });

  test("session persistence loads sqlite usage snapshots without cached tokens as null", async () => {
    await withDataDir("llm-bot-session-persist-cached-tokens-compat-test", async (dataDir: string) => {
      const persistence = new SessionPersistence(dataDir, pino({ level: "silent" }));
      await persistence.init();

      const db = await (persistence as any).getReadyDb();
      db.prepare(`
        INSERT INTO sessions (
          session_id, type, source, mode_id, operation_mode_json,
          participant_kind, participant_id, title, title_source, reply_delivery,
          pending_messages_json, pending_transcript_group_id, active_transcript_group_id,
          history_summary, history_backfill_boundary_ms, internal_transcript_json,
          debug_markers_json, last_llm_usage_json, sent_messages_json,
          last_active_at_ms, last_message_at_ms, latest_gap_ms, smoothed_gap_ms, updated_at_ms
        ) VALUES (
          @sessionId, @type, NULL, NULL, NULL,
          @participantKind, @participantId, @title, @titleSource, NULL,
          @pendingMessagesJson, NULL, NULL,
          NULL, NULL, @internalTranscriptJson,
          @debugMarkersJson, @lastLlmUsageJson, @sentMessagesJson,
          @lastActiveAtMs, @lastMessageAtMs, NULL, NULL, @updatedAtMs
        )
      `).run({
        sessionId: "qqbot:p:compat",
        type: "private",
        participantKind: "user",
        participantId: "compat",
        title: "Compat",
        titleSource: "default",
        pendingMessagesJson: "[]",
        internalTranscriptJson: "[]",
        debugMarkersJson: "[]",
        lastLlmUsageJson: JSON.stringify({
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
          requestCount: 1,
          providerReported: true,
          modelRef: "compat",
          model: "compat-model",
          capturedAt: 2
        }),
        sentMessagesJson: "[]",
        lastActiveAtMs: 1,
        lastMessageAtMs: 1,
        updatedAtMs: 1
      });

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
