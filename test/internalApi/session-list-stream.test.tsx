import test from "node:test";
import assert from "node:assert/strict";
import type { InternalApiSessionSummary } from "../../src/internalApi/types.ts";
import {
  buildInitialSessionListStreamEvents,
  diffSessionListStreamEvents
} from "../../src/internalApi/application/sessionListStream.ts";
import { getSessionListStream } from "../../src/internalApi/application/basicAdminService.ts";

function createSessionSummary(
  overrides?: Partial<InternalApiSessionSummary> & Pick<InternalApiSessionSummary, "id">
): InternalApiSessionSummary {
  return {
    id: overrides?.id ?? "web:1",
    type: overrides?.type ?? "private",
    source: overrides?.source ?? "web",
    modeId: overrides?.modeId ?? "rp_assistant",
    participantRef: overrides?.participantRef ?? { kind: "user", id: "owner" },
    title: overrides?.title ?? "New Chat",
    titleSource: overrides?.titleSource ?? "default",
    isGenerating: overrides?.isGenerating ?? false,
    lastActiveAt: overrides?.lastActiveAt ?? 10
  };
}

test("session list stream emits ready snapshot sorted by lastActiveAt desc", () => {
  const events = buildInitialSessionListStreamEvents([
    createSessionSummary({ id: "web:older", lastActiveAt: 10 }),
    createSessionSummary({ id: "web:newer", lastActiveAt: 20, title: "新标题", titleSource: "auto" })
  ]);

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "ready");
  if (events[0]?.type !== "ready") {
    return;
  }
  assert.deepEqual(events[0].sessions.map((session) => session.id), ["web:newer", "web:older"]);
  assert.equal(events[0].sessions[0]?.title, "新标题");
  assert.equal(events[0].sessions[0]?.titleSource, "auto");
  assert.equal(typeof events[0].timestampMs, "number");
});

test("session list stream emits session_upsert when title changes", () => {
  const previous = [createSessionSummary({ id: "web:1" })];
  const current = [createSessionSummary({
    id: "web:1",
    title: "仓库排查",
    titleSource: "auto",
    lastActiveAt: 30
  })];

  const events = diffSessionListStreamEvents(previous, current);
  assert.deepEqual(events.map((event) => event.type), ["session_upsert"]);
  const upsertEvent = events[0];
  assert.equal(upsertEvent?.type, "session_upsert");
  if (upsertEvent?.type !== "session_upsert") {
    return;
  }
  assert.equal(upsertEvent.session.title, "仓库排查");
  assert.equal(upsertEvent.session.titleSource, "auto");
  assert.equal(upsertEvent.session.lastActiveAt, 30);
});

test("session list stream emits session_removed when a session disappears", () => {
  const events = diffSessionListStreamEvents([
    createSessionSummary({ id: "web:removed", title: "to delete", titleSource: "manual", lastActiveAt: 1 })
  ], []);

  assert.deepEqual(events.map((event) => event.type), ["session_removed"]);
  const removedEvent = events[0];
  assert.equal(removedEvent?.type, "session_removed");
  if (removedEvent?.type !== "session_removed") {
    return;
  }
  assert.equal(removedEvent.sessionId, "web:removed");
});

test("session list service emits upsert when subscribed session title changes", async () => {
  const sessions: Array<InternalApiSessionSummary & { phase: { kind: string } }> = [{
    ...createSessionSummary({ id: "web:1" }),
    phase: { kind: "idle" }
  }];
  let listener: (() => void) | null = null;

  const stream = getSessionListStream({
    sessionManager: {
      listSessions() {
        return sessions as any;
      },
      getSessionView() {
        throw new Error("not used");
      },
      getLlmVisibleHistory() {
        return [];
      },
      getHistoryRevision() {
        return 0;
      },
      getMutationEpoch() {
        return 0;
      },
      subscribeSessions(nextListener: () => void) {
        listener = nextListener;
        return () => {
          listener = null;
        };
      }
    },
    scenarioHostStateStore: {} as never,
    sessionCaptioner: {} as never,
    chatFileStore: {} as never,
    audioStore: {} as never
  });

  const received = [...stream.initialEvents];
  const unsubscribe = stream.subscribe((event) => {
    received.push(event);
  });

  sessions[0] = createSessionSummary({
    id: "web:1",
    title: "仓库排查",
    titleSource: "auto",
    lastActiveAt: 30
  }) as InternalApiSessionSummary & { phase: { kind: string } };
  sessions[0]!.phase = { kind: "idle" };
  const activeListener = listener;
  if (activeListener) {
    (activeListener as () => void)();
  }
  unsubscribe();

  assert.deepEqual(received.map((event) => event.type), ["ready", "session_upsert"]);
  const upsertEvent = received[1];
  assert.equal(upsertEvent?.type, "session_upsert");
  if (upsertEvent?.type !== "session_upsert") {
    return;
  }
  assert.equal(upsertEvent.session.title, "仓库排查");
  assert.equal(upsertEvent.session.titleSource, "auto");
});
