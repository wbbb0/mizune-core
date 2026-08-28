import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import {
  persistedSessionStateSchema,
  SessionPersistence
} from "../../src/conversation/session/sessionPersistence.ts";
import type { PersistedSessionState } from "../../src/conversation/session/sessionManager.ts";
import { createSessionState, restoreSessionState, toPersistedSessionState } from "../../src/conversation/session/sessionStateFactory.ts";
import { clearSessionState } from "../../src/conversation/session/sessionMutations.ts";
import { createEmptyPersona } from "../../src/persona/personaSchema.ts";
import { createEmptyRpProfile } from "../../src/modes/rpAssistant/profileSchema.ts";
import { createEmptySessionTaskTracker } from "../../src/conversation/taskTracker/taskTrackerTypes.ts";
import { sessionDataDomain } from "../../src/conversation/session/sessionDataModel.ts";
import { createTableGroupsFromDataDomain } from "../../src/data/model/index.ts";
import { SqliteService } from "../../src/data/sqlite/sqliteService.ts";

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

test("session persistence round-trips session settings", async () => {
  await withDataDir("llm-bot-session-pacing-test", async (dataDir: string) => {
    const persistence = new SessionPersistence(dataDir, pino({ level: "silent" }));
    await persistence.init();
    const session = createSessionState({
      id: "web:pacing",
      type: "private",
      source: "web"
    });
    session.pacingPreferences = {
      inputDebounce: { mode: "fixed", delayMs: 2_500 },
      oneBotOutbound: "humanized",
      toolLoopOutput: "final_only"
    };
    session.toolsetPreferences = {
      overrides: {
        web_research: "disabled",
        dice_roller: "enabled"
      }
    };
    session.modelRoutingPreferences = {
      selfUpgradeEnabled: false
    };

    await persistence.save(toPersistedSessionState(session));
    const [loaded] = await persistence.loadAll();
    assert.ok(loaded);
    assert.deepEqual(loaded.pacingPreferences, session.pacingPreferences);
    assert.deepEqual(loaded.toolsetPreferences, session.toolsetPreferences);
    assert.deepEqual(loaded.modelRoutingPreferences, session.modelRoutingPreferences);
    assert.deepEqual(restoreSessionState(loaded).pacingPreferences, session.pacingPreferences);
    assert.deepEqual(restoreSessionState(loaded).toolsetPreferences, session.toolsetPreferences);
    assert.deepEqual(restoreSessionState(loaded).modelRoutingPreferences, session.modelRoutingPreferences);
  });
});

test("sessions without settings derive defaults", () => {
  const web = toPersistedSessionState(createSessionState({
    id: "web:legacy-pacing",
    type: "private",
    source: "web"
  }));
  const oneBot = toPersistedSessionState(createSessionState({
    id: "qqbot:p:legacy-pacing",
    type: "private",
    source: "onebot"
  }));
  delete web.pacingPreferences;
  delete oneBot.pacingPreferences;
  delete web.toolsetPreferences;
  delete oneBot.toolsetPreferences;
  delete web.modelRoutingPreferences;
  delete oneBot.modelRoutingPreferences;

  assert.deepEqual(restoreSessionState(web).pacingPreferences, {
    inputDebounce: { mode: "immediate" },
    oneBotOutbound: "immediate",
    toolLoopOutput: "progressive"
  });
  assert.deepEqual(restoreSessionState(oneBot).pacingPreferences, {
    inputDebounce: { mode: "adaptive" },
    oneBotOutbound: "humanized",
    toolLoopOutput: "progressive"
  });
  assert.deepEqual(restoreSessionState(web).toolsetPreferences, { overrides: {} });
  assert.deepEqual(restoreSessionState(oneBot).toolsetPreferences, { overrides: {} });
  assert.deepEqual(restoreSessionState(web).modelRoutingPreferences, { selfUpgradeEnabled: true });
  assert.deepEqual(restoreSessionState(oneBot).modelRoutingPreferences, { selfUpgradeEnabled: true });
});

test("persisted sessions accept the previous pacing shape and strip legacy evidence", () => {
  const persisted = toPersistedSessionState(createSessionState({
    id: "web:legacy-session-shape",
    type: "private",
    source: "web"
  }));
  const parsed = persistedSessionStateSchema.parse({
    ...persisted,
    pacingPreferences: {
      inputDebounce: { mode: "immediate" },
      oneBotOutbound: "immediate"
    },
    taskTracker: {
      ...persisted.taskTracker,
      evidence: [{ legacy: true }]
    }
  });

  assert.equal(parsed.pacingPreferences?.toolLoopOutput, "progressive");
  assert.equal("evidence" in parsed.taskTracker, false);
});

test("session schema version 6 migrates to session settings storage", async () => {
  await withDataDir("llm-bot-session-pacing-migration-test", async (dataDir: string) => {
    const logger = pino({ level: "silent" });
    const sessionsTable = sessionDataDomain.tables.sessions;
    assert.ok(sessionsTable);
    const oldDomain = {
      ...sessionDataDomain,
      schemaVersion: 6,
      minReadableSchemaVersion: 6,
      tables: {
        ...sessionDataDomain.tables,
        sessions: {
          ...sessionsTable,
          columns: sessionsTable.columns.filter((column) => (
            column.key !== "pacingPreferencesJson"
            && column.key !== "toolsetPreferencesJson"
            && column.key !== "modelRoutingPreferencesJson"
            && column.key !== "botProfileJson"
          ))
        }
      }
    };
    const dbPath = join(dataDir, "sessions", "sessions.sqlite");
    const oldHandle = await new SqliteService(logger).openDatabase({
      databaseId: "sessions",
      dbPath,
      tableGroups: createTableGroupsFromDataDomain(oldDomain)
    });
    oldHandle.close();

    const persistence = new SessionPersistence(dataDir, logger);
    await persistence.init();
    const persisted = toPersistedSessionState(createSessionState({
      id: "web:migrated-pacing",
      type: "private",
      source: "web"
    }));
    persisted.toolsetPreferences = { overrides: { web_research: "disabled" } };
    await persistence.save(persisted);

    const [loaded] = await persistence.loadAll();
    assert.deepEqual(loaded?.pacingPreferences, persisted.pacingPreferences);
    assert.deepEqual(loaded?.toolsetPreferences, persisted.toolsetPreferences);
  });
});

test("session schema version 9 migrates and persists model routing preferences", async () => {
  await withDataDir("llm-bot-session-model-routing-migration-test", async (dataDir: string) => {
    const logger = pino({ level: "silent" });
    const sessionsTable = sessionDataDomain.tables.sessions;
    assert.ok(sessionsTable);
    const oldDomain = {
      ...sessionDataDomain,
      schemaVersion: 9,
      minReadableSchemaVersion: 6,
      tables: {
        ...sessionDataDomain.tables,
        sessions: {
          ...sessionsTable,
          columns: sessionsTable.columns.filter((column) => column.key !== "modelRoutingPreferencesJson")
        }
      }
    };
    const dbPath = join(dataDir, "sessions", "sessions.sqlite");
    const oldHandle = await new SqliteService(logger).openDatabase({
      databaseId: "sessions",
      dbPath,
      tableGroups: createTableGroupsFromDataDomain(oldDomain)
    });
    oldHandle.close();

    const persistence = new SessionPersistence(dataDir, logger);
    await persistence.init();
    const session = createSessionState({ id: "web:model-routing", type: "private", source: "web" });
    session.modelRoutingPreferences.selfUpgradeEnabled = false;
    await persistence.save(toPersistedSessionState(session));

    const [loaded] = await persistence.loadAll();
    assert.deepEqual(loaded?.modelRoutingPreferences, { selfUpgradeEnabled: false });
  });
});

test("session schema version 8 migrates and persists per-session bot profile", async () => {
  await withDataDir("llm-bot-session-profile-migration-test", async (dataDir: string) => {
    const logger = pino({ level: "silent" });
    const sessionsTable = sessionDataDomain.tables.sessions;
    assert.ok(sessionsTable);
    const oldDomain = {
      ...sessionDataDomain,
      schemaVersion: 8,
      minReadableSchemaVersion: 6,
      tables: {
        ...sessionDataDomain.tables,
        sessions: {
          ...sessionsTable,
          columns: sessionsTable.columns.filter((column) => column.key !== "botProfileJson")
        }
      }
    };
    const dbPath = join(dataDir, "sessions", "sessions.sqlite");
    const oldHandle = await new SqliteService(logger).openDatabase({
      databaseId: "sessions",
      dbPath,
      tableGroups: createTableGroupsFromDataDomain(oldDomain)
    });
    oldHandle.close();

    const persistence = new SessionPersistence(dataDir, logger);
    await persistence.init();
    const session = createSessionState({ id: "web:session-profile", type: "private", source: "web" });
    assert.equal(session.botProfile, null);
    session.botProfile = {
      name: "小岚",
      identity: "摄影师",
      background: "住在杭州",
      temperament: "松弛",
      voiceStyle: "自然随意"
    };
    await persistence.save(toPersistedSessionState(session));

    const [loaded] = await persistence.loadAll();
    assert.deepEqual(loaded?.botProfile, session.botProfile);
  });
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
        identity: "Keeps a steady composure"
      }
    };

    const persisted = toPersistedSessionState(session);

    assert.deepEqual(persisted.operationMode, {
      kind: "mode_setup",
      modeId: "rp_assistant",
      draft: {
        ...createEmptyRpProfile(),
        identity: "Keeps a steady composure"
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
      taskTracker: createEmptySessionTaskTracker(),
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
      taskTracker: createEmptySessionTaskTracker(),
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

test("session persistence handles transcript item index shifts", async () => {
  await withDataDir("llm-bot-session-persist-transcript-index-shift-test", async (dataDir: string) => {
    const persistence = new SessionPersistence(dataDir, pino({ level: "silent" }));
    await persistence.init();

    const baseSession: PersistedSessionState = {
      id: "web:transcript-index-shift",
      type: "private",
      source: "web",
      modeId: "assistant",
      operationMode: { kind: "normal" },
      participantRef: { kind: "user", id: "owner" },
      title: "Transcript Index Shift",
      titleSource: "manual",
      replyDelivery: "web",
      pendingMessages: [],
      pendingTranscriptGroupId: null,
      activeTranscriptGroupId: null,
      historySummary: null,
      taskTracker: createEmptySessionTaskTracker(),
      internalTranscript: [
        testUserTranscriptItem("item-a", "first", 1),
        testUserTranscriptItem("item-b", "second", 2)
      ],
      debugMarkers: [],
      lastLlmUsage: null,
      sentMessages: [],
      lastActiveAt: 2,
      lastMessageAt: 2,
      latestGapMs: null,
      smoothedGapMs: null
    };
    await persistence.save(baseSession);

    const shiftedSession: PersistedSessionState = {
      ...baseSession,
      internalTranscript: [
        testUserTranscriptItem("item-new", "new first", 3),
        testUserTranscriptItem("item-a", "first", 1),
        testUserTranscriptItem("item-b", "second", 2)
      ],
      lastActiveAt: 3,
      lastMessageAt: 3
    };

    await persistence.save(shiftedSession);

    assert.deepEqual(await persistence.loadAll(), [shiftedSession]);
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
      providerMetadata: {
        openAiResponses: {
          outputItems: [{ type: "message", role: "assistant" }]
        }
      },
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
  assert.deepEqual(
    item.kind === "assistant_message" ? item.providerMetadata : undefined,
    {
      openAiResponses: {
        outputItems: [{ type: "message", role: "assistant" }]
      }
    }
  );
});

function testUserTranscriptItem(id: string, text: string, timestampMs: number): PersistedSessionState["internalTranscript"][number] {
  return {
    id,
    groupId: id,
    kind: "user_message",
    role: "user",
    llmVisible: true,
    chatType: "private",
    userId: "owner",
    senderName: "Owner",
    text,
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
    timestampMs
  };
}

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
        taskTracker: createEmptySessionTaskTracker(),
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
            kind: "model_route_event",
            llmVisible: false,
            timestampMs: 5,
            routeType: "self_upgrade",
            fromRole: "main_small",
            toRole: "main_large",
            title: "模型路由 · 自助升级",
            summary: "后续请求已切换到完整模型路由",
            reason: "任务复杂",
            fromModelRefs: ["small"],
            toModelRefs: ["large"],
            provider: "provider_a"
          },
          {
            kind: "internal_trigger_event",
            llmVisible: false,
            timestampMs: 6,
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
        taskTracker: createEmptySessionTaskTracker(),
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
          pending_messages_json,
          history_summary, history_backfill_boundary_ms,
          debug_markers_json, last_llm_usage_json, sent_messages_json,
          last_active_at_ms, last_message_at_ms, latest_gap_ms, smoothed_gap_ms, updated_at_ms
        ) VALUES (
          'qqbot:p:legacy', 'private', NULL, NULL, NULL,
          'user', '', NULL, NULL, NULL,
          '[{"userId":"owner"}]',
          NULL, NULL,
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
          pending_messages_json,
          history_summary, history_backfill_boundary_ms,
          debug_markers_json, last_llm_usage_json, sent_messages_json,
          last_active_at_ms, last_message_at_ms, latest_gap_ms, smoothed_gap_ms, updated_at_ms
        ) VALUES (
          @sessionId, @type, NULL, NULL, NULL,
          @participantKind, @participantId, @title, @titleSource, NULL,
          @pendingMessagesJson,
          NULL, NULL,
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
        taskTracker: createEmptySessionTaskTracker(),
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
