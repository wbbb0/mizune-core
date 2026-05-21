import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { createTableGroupsFromDataDomain } from "../../src/data/model/index.ts";
import { SqliteService } from "../../src/data/sqlite/sqliteService.ts";
import { sessionDataDomain } from "../../src/conversation/session/sessionDataModel.ts";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { SessionPersistence } from "../../src/conversation/session/sessionPersistence.ts";
import { createSessionState, restoreSessionState, toPersistedSessionState } from "../../src/conversation/session/sessionStateFactory.ts";
import { createEmptySessionTaskTracker, type SessionTaskTracker } from "../../src/conversation/taskTracker/taskTrackerTypes.ts";
import { normalizeTaskTracker } from "../../src/conversation/taskTracker/taskTrackerNormalize.ts";
import { buildTurnPlannerTaskContext } from "../../src/conversation/taskTracker/taskTrackerPlannerContext.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

async function withDataDir(name: string, fn: (dataDir: string) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), `${name}-`));
  try {
    await fn(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("new sessions start with an empty task tracker", () => {
  const session = createSessionState({
    id: "web:task-tracker-default",
    type: "private",
    source: "web",
    participantRef: { kind: "user", id: "owner" }
  });

  assert.deepEqual(session.taskTracker, createEmptySessionTaskTracker());
  assert.deepEqual(toPersistedSessionState(session).taskTracker, createEmptySessionTaskTracker());
});

test("session manager task tracker updates normalize bounded arrays", () => {
  const manager = new SessionManager(createTestAppConfig());
  manager.ensureSession({
    id: "web:task-tracker-normalize",
    type: "private",
    source: "web",
    participantRef: { kind: "user", id: "owner" }
  });

  const updated = manager.updateTaskTracker("web:task-tracker-normalize", () => buildOversizedTracker());

  assert.equal(updated.parked.length, 2);
  assert.equal(updated.evidence.length, 64);
  assert.equal(updated.primary?.done.length, 12);
  assert.equal(updated.primary?.next.length, 8);
  assert.equal(updated.primary?.blockers.length, 8);
  assert.equal(updated.primary?.importantToolRefs.length, 12);
});

test("session view task tracker evidence omits large replay and canonical payloads", () => {
  const manager = new SessionManager(createTestAppConfig());
  const sessionId = "web:task-tracker-view";
  manager.ensureSession({
    id: sessionId,
    type: "private",
    source: "web",
    participantRef: { kind: "user", id: "owner" }
  });
  manager.setTaskTracker(sessionId, {
    version: 1,
    primary: null,
    parked: [],
    evidence: [{
      evidenceId: "e1",
      sessionId,
      taskId: "task-1",
      toolCallId: "call-1",
      toolName: "terminal_run",
      summary: "终端输出",
      replayContent: "large replay",
      canonicalContent: "large canonical",
      contentHash: "hash",
      pinned: true,
      createdAtMs: 1
    }]
  });

  const evidence = manager.getSessionView(sessionId).taskTracker.evidence[0];
  assert.equal(evidence?.summary, "终端输出");
  assert.equal(evidence?.replayContent, undefined);
  assert.equal(evidence?.canonicalContent, undefined);
  assert.equal(manager.getSession(sessionId).taskTracker.evidence[0]?.canonicalContent, "large canonical");
});

test("turn planner task context hides completed primary task", () => {
  const context = buildTurnPlannerTaskContext({
    version: 1,
    primary: {
      taskId: "task-1",
      status: "completed",
      objective: "已经结束的任务",
      done: [],
      next: [],
      blockers: [],
      importantToolRefs: [],
      createdAtMs: 1,
      updatedAtMs: 2
    },
    parked: [],
    evidence: []
  });

  assert.equal(context, null);
});

test("task tracker normalization bounds nested strings and strips undefined optional keys", () => {
  const long = "x".repeat(2_000);
  const tracker = normalizeTaskTracker({
    version: 1,
    primary: {
      taskId: long,
      status: "active",
      objective: long,
      originalRequest: undefined,
      done: [],
      next: [],
      blockers: [],
      importantToolRefs: [{
        toolCallId: long,
        toolName: long,
        summary: undefined,
        resource: {
          kind: "browser_page",
          id: long,
          locator: long,
          version: undefined
        },
        refetchHint: undefined,
        pinned: undefined,
        createdAtMs: undefined
      }],
      createdAtMs: 1,
      updatedAtMs: 2,
      readyToCloseAtMs: undefined
    },
    parked: [],
    evidence: [{
      evidenceId: long,
      sessionId: long,
      taskId: long,
      toolCallId: long,
      toolName: long,
      summary: long,
      resource: {
        kind: "browser_page",
        id: long,
        locator: long,
        version: undefined
      },
      replayContent: undefined,
      canonicalContent: undefined,
      canonicalTruncated: undefined,
      contentHash: long,
      pinned: false,
      createdAtMs: 3
    }]
  });

  assert.equal(tracker.primary?.taskId.length, 160);
  assert.equal(tracker.primary?.importantToolRefs[0]?.toolName.length, 120);
  assert.equal(tracker.primary?.importantToolRefs[0]?.resource?.locator?.length, 512);
  assert.equal(tracker.evidence[0]?.contentHash.length, 160);
  assert.equal("originalRequest" in tracker.primary!, false);
  assert.equal("summary" in tracker.primary!.importantToolRefs[0]!, false);
  assert.equal("version" in tracker.primary!.importantToolRefs[0]!.resource!, false);
  assert.equal("canonicalContent" in tracker.evidence[0]!, false);
});

test("session task tracker persists and restores", async () => {
  await withDataDir("llm-bot-session-task-tracker-roundtrip-test", async (dataDir: string) => {
    const persistence = new SessionPersistence(dataDir, pino({ level: "silent" }));
    await persistence.init();

    const session = createSessionState({
      id: "web:task-tracker-roundtrip",
      type: "private",
      source: "web",
      participantRef: { kind: "user", id: "owner" },
      title: "Task Tracker",
      titleSource: "manual"
    });
    session.taskTracker = {
      version: 1,
      primary: {
        taskId: "task-1",
        status: "active",
        objective: "验证 task tracker 持久化",
        originalRequest: "帮我验证 task tracker",
        done: ["已创建状态"],
        next: ["写入 SQLite"],
        blockers: [],
        importantToolRefs: [{
          toolCallId: "call-1",
          toolName: "terminal_run",
          summary: "执行测试命令",
          createdAtMs: 10
        }],
        createdAtMs: 1,
        updatedAtMs: 10
      },
      parked: [],
      evidence: []
    };

    await persistence.save(toPersistedSessionState(session));
    const [loaded] = await persistence.loadAll();

    assert.ok(loaded?.taskTracker);
    assert.deepEqual(loaded.taskTracker, session.taskTracker);
    assert.deepEqual(restoreSessionState(loaded).taskTracker, session.taskTracker);
  });
});

test("legacy persisted sessions restore with default task tracker", () => {
  const restored = restoreSessionState({
    id: "web:task-tracker-legacy",
    type: "private",
    source: "web",
    modeId: "assistant",
    operationMode: { kind: "normal" },
    participantRef: { kind: "user", id: "owner" },
    title: "Legacy",
    titleSource: "manual",
    replyDelivery: "web",
    pendingMessages: [],
    pendingTranscriptGroupId: null,
    activeTranscriptGroupId: null,
    historySummary: null,
    internalTranscript: [],
    debugMarkers: [],
    lastLlmUsage: null,
    sentMessages: [],
    lastActiveAt: 1,
    lastMessageAt: 1,
    latestGapMs: null,
    smoothedGapMs: null
  });

  assert.deepEqual(restored.taskTracker, createEmptySessionTaskTracker());
});

test("sqlite v3 session schema migrates with default task tracker", async () => {
  await withDataDir("llm-bot-session-task-tracker-sqlite-migration-test", async (dataDir: string) => {
    const logger = pino({ level: "silent" });
    const dbPath = join(dataDir, "sessions", "sessions.sqlite");
    const oldSessionsTable = sessionDataDomain.tables.sessions;
    assert.ok(oldSessionsTable);
    const oldDomain = {
      ...sessionDataDomain,
      schemaVersion: 3,
      tables: {
        ...sessionDataDomain.tables,
        sessions: {
          ...oldSessionsTable,
          columns: oldSessionsTable.columns.filter((column) => column.key !== "taskTrackerJson")
        }
      }
    };
    const oldHandle = await new SqliteService(logger).openDatabase({
      databaseId: "sessions",
      dbPath,
      tableGroups: createTableGroupsFromDataDomain(oldDomain),
      pragmas: {
        wal: true,
        foreignKeys: true,
        busyTimeoutMs: 5000
      }
    });
    oldHandle.db.prepare(`
      INSERT INTO sessions (
        session_id, type, participant_kind, participant_id, title, title_source,
        pending_messages_json, history_summary, debug_markers_json, sent_messages_json,
        last_active_at_ms, last_message_at_ms, latest_gap_ms, smoothed_gap_ms, updated_at_ms
      ) VALUES (
        @sessionId, 'private', 'user', @participantId, @title, 'manual',
        '[]', NULL, '[]', '[]',
        1, 1, NULL, NULL, 1
      )
    `).run({
      sessionId: "web:v3-task-tracker-migration",
      participantId: "owner",
      title: "Migration"
    });
    oldHandle.close();

    const persistence = new SessionPersistence(dataDir, logger);
    await persistence.init();

    assert.deepEqual(await persistence.loadAll(), [{
      id: "web:v3-task-tracker-migration",
      type: "private",
      source: "onebot",
      modeId: "rp_assistant",
      operationMode: { kind: "normal" },
      participantRef: { kind: "user", id: "owner" },
      title: "Migration",
      titleSource: "manual",
      replyDelivery: "onebot",
      pendingMessages: [],
      historySummary: null,
      taskTracker: createEmptySessionTaskTracker(),
      internalTranscript: [],
      debugMarkers: [],
      lastLlmUsage: null,
      sentMessages: [],
      lastActiveAt: 1,
      lastMessageAt: 1,
      latestGapMs: null,
      smoothedGapMs: null
    }]);
  });
});

test("normalizeTaskTracker falls back to default for malformed persisted state", () => {
  assert.deepEqual(normalizeTaskTracker({ version: 99 }), createEmptySessionTaskTracker());
});

function buildOversizedTracker(): SessionTaskTracker {
  return {
    version: 1,
    primary: {
      taskId: "task-oversized",
      status: "active",
      objective: "oversized",
      done: Array.from({ length: 20 }, (_, index) => `done-${index}`),
      next: Array.from({ length: 20 }, (_, index) => `next-${index}`),
      blockers: Array.from({ length: 20 }, (_, index) => `blocker-${index}`),
      importantToolRefs: Array.from({ length: 20 }, (_, index) => ({
        toolCallId: `call-${index}`,
        toolName: "terminal_run",
        summary: `summary-${index}`
      })),
      createdAtMs: 1,
      updatedAtMs: 2
    },
    parked: Array.from({ length: 4 }, (_, index) => ({
      taskId: `parked-${index}`,
      status: "suspended",
      objective: `parked objective ${index}`,
      summary: `parked summary ${index}`,
      importantToolRefs: [],
      updatedAtMs: index
    })),
    evidence: Array.from({ length: 80 }, (_, index) => ({
      evidenceId: `evidence-${index}`,
      sessionId: "web:task-tracker-normalize",
      taskId: "task-oversized",
      toolCallId: `call-${index}`,
      toolName: "terminal_run",
      summary: `evidence summary ${index}`,
      replayContent: `replay ${index}`,
      contentHash: `hash-${index}`,
      pinned: false,
      createdAtMs: index
    }))
  };
}
