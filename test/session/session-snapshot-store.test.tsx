import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { SessionSnapshotStore } from "../../src/conversation/session/sessionSnapshotStore.ts";
import { createSessionState, toPersistedSessionState } from "../../src/conversation/session/sessionStateFactory.ts";
import { createInitialScenarioHostSessionState } from "../../src/modes/scenarioHost/types.ts";

async function withDataDir(name: string, fn: (dataDir: string) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), `${name}-`));
  try {
    await fn(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("session snapshot store persists session and scenario mode state", async () => {
  await withDataDir("llm-bot-session-snapshot-store-test", async (dataDir) => {
    const store = new SessionSnapshotStore(dataDir, pino({ level: "silent" }));
    await store.init();
    const session = createSessionState({
      id: "web:snapshot",
      type: "private",
      source: "web",
      participantRef: { kind: "user", id: "owner" },
      title: "快照会话",
      titleSource: "manual"
    });
    session.modeId = "scenario_host";
    session.internalTranscript.push({
      id: "assistant-1",
      kind: "assistant_message",
      role: "assistant",
      chatType: "private",
      userId: "owner",
      text: "开场",
      senderName: "assistant",
      llmVisible: true,
      groupId: "group-1",
      timestampMs: 10
    });
    const scenarioState = createInitialScenarioHostSessionState({
      playerUserId: "owner",
      playerDisplayName: "玩家"
    });

    const created = await store.create({
      sessionId: session.id,
      label: "第一章",
      session: toPersistedSessionState(session),
      modeState: {
        kind: "scenario_host",
        state: scenarioState
      }
    });

    assert.equal(created.label, "第一章");
    assert.equal(created.modeId, "scenario_host");
    assert.equal(created.transcriptCount, 1);
    assert.equal(created.hasScenarioHostState, true);

    const listed = await store.list(session.id);
    assert.deepEqual(listed, [created]);

    const loaded = await store.get(session.id, created.id);
    assert.ok(loaded);
    assert.equal(loaded.payload.session.title, "快照会话");
    assert.equal(loaded.payload.modeState?.kind, "scenario_host");
    assert.equal(loaded.payload.modeState?.state.player.displayName, "玩家");

    assert.equal(await store.delete(session.id, created.id), true);
    assert.deepEqual(await store.list(session.id), []);
  });
});
