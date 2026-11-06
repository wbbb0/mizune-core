import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import Database from "better-sqlite3";
import { AudioStore } from "../../src/audio/audioStore.ts";
import { SessionPersistence } from "../../src/conversation/session/sessionPersistence.ts";
import { SessionSnapshotStore } from "../../src/conversation/session/sessionSnapshotStore.ts";
import { createSessionState, toPersistedSessionState } from "../../src/conversation/session/sessionStateFactory.ts";
import { createUserTranscriptMessageItem } from "../../src/conversation/session/historyContext.ts";
import { clearSessionState } from "../../src/conversation/session/sessionMutations.ts";
import type { InternalToolResultItem } from "../../src/conversation/session/sessionTypes.ts";
import { AssetsDatabase } from "../../src/data/assets/assetsDatabase.ts";
import { AssetLifecycleService } from "../../src/data/assets/assetLifecycleService.ts";
import { AssetLifecycleStore } from "../../src/data/assets/assetLifecycleStore.ts";
import { AssetReferenceCoordinator } from "../../src/data/assets/assetReferenceCoordinator.ts";
import { collectTranscriptMediaIds } from "../../src/data/assets/sessionAssetReferences.ts";
import { ChatFileStore } from "../../src/services/workspace/chatFileStore.ts";
import { LocalFileService } from "../../src/services/workspace/localFileService.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

const logger = pino({ level: "silent" });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function createFixture(dataDir: string) {
  const config = createTestAppConfig({
    localFiles: { enabled: true, root: dataDir },
    chatFiles: { enabled: true, root: "chat-files", maxUploadBytes: 1024 }
  });
  const assetsDatabase = new AssetsDatabase(dataDir, logger);
  const localFiles = new LocalFileService(config, dataDir);
  const files = new ChatFileStore(config, logger, localFiles, dataDir, assetsDatabase);
  const audioStore = new AudioStore(dataDir, logger, assetsDatabase);
  const coordinator = new AssetReferenceCoordinator((ids) => files.retainFiles(ids));
  const persistence = new SessionPersistence(dataDir, logger, undefined, coordinator);
  const snapshots = new SessionSnapshotStore(dataDir, logger, undefined, coordinator, assetsDatabase);
  const lifecycle = new AssetLifecycleService(new AssetLifecycleStore(dataDir, logger, assetsDatabase), {
    chatFileStore: files,
    audioStore,
    comfyTaskStore: {
      async listRows() { return { rows: [], total: 0, offset: 0, limit: 500 }; },
      async deleteById() { return false; }
    },
    getPersistedAssetReferences: () => persistence.listAssetReferences()
  }, logger, { enabled: true, ttlMs: 1, orphanFileTtlMs: 1, maxTotalBytes: 1, targetTotalBytes: 0 }, coordinator);
  await localFiles.init();
  await files.init();
  await audioStore.init();
  await persistence.init();
  await snapshots.init();
  await lifecycle.init();
  const file = await files.importBuffer({
    buffer: Buffer.from("archived-media"), sourceName: "archive.txt", mimeType: "text/plain", kind: "file", origin: "browser_download"
  });
  const [audio] = await audioStore.registerSources(["https://example.invalid/archived-audio.wav"]);
  assert.ok(audio);
  const session = createSessionState({ id: "web:archive", type: "private", source: "web" });
  session.internalTranscript.push(createUserTranscriptMessageItem({
    chatType: "private", userId: "owner", senderName: "Owner", text: "存档媒体", timestampMs: 1,
    contentParts: [{ kind: "embedded_message", relation: "reply", parts: [
      { kind: "asset_file", fileId: file.fileId, fileKind: "file", sourceName: "archive.txt", mimeType: "text/plain", sizeBytes: file.sizeBytes },
      { kind: "audio", audioId: audio.id }
    ] }]
  }));
  const sweep = () => lifecycle.sweep({ activeSessions: [], persistedSessions: [], now: Date.now() + 10_000 });
  return { dataDir, persistence, snapshots, coordinator, lifecycle, session, file, files, audio, audioStore, sweep };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "mizune-session-asset-ownership-"));
  try { await run(await createFixture(dataDir)); }
  finally { await rm(dataDir, { recursive: true, force: true }); }
}

async function archiveAndClear(fixture: Fixture) {
  const { persistence, snapshots, session } = fixture;
  await persistence.save(toPersistedSessionState(session));
  const snapshot = await snapshots.create({ sessionId: session.id, session: toPersistedSessionState(session), modeState: null });
  clearSessionState(session);
  await persistence.save(toPersistedSessionState(session));
  return snapshot;
}

async function assertMediaPresent({ files, file, audioStore, audio, dataDir }: Fixture) {
  assert.ok(await files.getFile(file.fileId));
  assert.equal((await readFile(join(dataDir, file.chatFilePath))).toString(), "archived-media");
  assert.ok(await audioStore.get(audio.id));
}

test("snapshot media survives clear, restart, TTL and size pressure without loading histories", async () => {
  await withFixture(async (fixture) => {
    const { persistence, snapshots, session, file, audio, dataDir, coordinator, sweep } = fixture;
    const snapshot = await archiveAndClear(fixture);
    const restartedPersistence = new SessionPersistence(dataDir, logger, undefined, coordinator);
    const restartedSnapshots = new SessionSnapshotStore(dataDir, logger, undefined, coordinator);
    await restartedPersistence.init();
    await restartedSnapshots.init();
    assert.deepEqual(await restartedPersistence.listAssetReferences(), [
      { assetKind: "audio", assetId: audio.id }, { assetKind: "chat_file", assetId: file.fileId }
    ]);
    assert.deepEqual((await sweep()).deletedChatFileIds, []);
    await assertMediaPresent(fixture);
    await restartedSnapshots.withSnapshot(session.id, snapshot.id, async ({ payload }) => {
      await persistence.save(payload.session);
    });
    assert.equal(await snapshots.delete(session.id, snapshot.id), true);
    await sweep();
    await assertMediaPresent(fixture);
    await persistence.remove(session.id);
    const collected = await sweep();
    assert.deepEqual(collected.deletedChatFileIds, [file.fileId]);
    assert.deepEqual(collected.deletedAudioIds, [audio.id]);
  });
});

test("snapshot owners are independent and deletion of the last owner releases media", async () => {
  await withFixture(async (fixture) => {
    const { persistence, snapshots, session, file, audio, sweep } = fixture;
    const first = await snapshots.create({ sessionId: session.id, session: toPersistedSessionState(session), modeState: null });
    await snapshots.create({ sessionId: session.id, session: toPersistedSessionState(session), modeState: null });
    await persistence.remove(session.id);
    assert.equal(await snapshots.delete("wrong-session", first.id), false);
    assert.equal(await snapshots.delete(session.id, first.id), true);
    await sweep();
    await assertMediaPresent(fixture);
    assert.equal(await snapshots.deleteAllForSession(session.id), 1);
    assert.deepEqual(await persistence.listAssetReferences(), []);
    const collected = await sweep();
    assert.deepEqual(collected.deletedChatFileIds, [file.fileId]);
    assert.deepEqual(collected.deletedAudioIds, [audio.id]);
  });
});

test("restore lease protects media after concurrent source deletion and permits nested session persistence", async () => {
  await withFixture(async (fixture) => {
    const { persistence, snapshots, session, files, coordinator, sweep } = fixture;
    const snapshot = await archiveAndClear(fixture);
    const entered = deferred();
    const resume = deferred();
    const restoring = snapshots.withSnapshot(session.id, snapshot.id, async ({ payload }) => {
      entered.resolve();
      await resume.promise;
      await persistence.save(payload.session);
      return payload.session.id;
    });
    await entered.promise;
    try {
      assert.equal(files.listRetainedFileIds().size, 1);
      assert.equal([...coordinator.retainedReferences()].length, 1, "chat leases use the existing file store; only audio is retained here");
      await snapshots.delete(session.id, snapshot.id);
      await sweep();
      await assertMediaPresent(fixture);
    } finally { resume.resolve(); }
    assert.equal(await restoring, session.id);
    assert.equal(files.listRetainedFileIds().size, 0);
    assert.deepEqual([...coordinator.retainedReferences()], []);
    await sweep();
    await assertMediaPresent(fixture);
  });
});

test("failed restore releases every temporary lease", async () => {
  await withFixture(async (fixture) => {
    const { snapshots, session, files, coordinator, file, audio, sweep } = fixture;
    const snapshot = await archiveAndClear(fixture);
    await assert.rejects(snapshots.withSnapshot(session.id, snapshot.id, async () => {
      await snapshots.delete(session.id, snapshot.id);
      await sweep();
      await assertMediaPresent(fixture);
      throw new Error("mode restore failed");
    }), /mode restore failed/);
    assert.equal(files.listRetainedFileIds().size, 0);
    assert.deepEqual([...coordinator.retainedReferences()], []);
    const collected = await sweep();
    assert.deepEqual(collected.deletedChatFileIds, [file.fileId]);
    assert.deepEqual(collected.deletedAudioIds, [audio.id]);
  });
});

test("GC retains the mutation boundary until final file deletion has completed", async () => {
  await withFixture(async (fixture) => {
    const { persistence, snapshots, session, files, sweep } = fixture;
    await persistence.save(toPersistedSessionState(session));
    const orphan = await files.importBuffer({ buffer: Buffer.from("orphan"), kind: "file", origin: "browser_download" });
    const deleting = deferred();
    const resume = deferred();
    const deleteFile = files.deleteFile.bind(files);
    files.deleteFile = async (id) => {
      if (id === orphan.fileId) { deleting.resolve(); await resume.promise; }
      return deleteFile(id);
    };
    const sweeping = sweep();
    await deleting.promise;
    let committed = false;
    const creating = snapshots.create({ sessionId: session.id, session: toPersistedSessionState(session), modeState: null })
      .then((snapshot) => { committed = true; return snapshot; });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(committed, false);
      assert.deepEqual(await snapshots.list(session.id), []);
    } finally { resume.resolve(); }
    assert.deepEqual((await sweeping).deletedChatFileIds, [orphan.fileId]);
    await creating;
    clearSessionState(session);
    await persistence.save(toPersistedSessionState(session));
    await sweep();
    await assertMediaPresent(fixture);
  });
});

test("a snapshot first referencing the same asset being collected is rejected after GC wins the boundary", async () => {
  await withFixture(async ({ persistence, snapshots, session, files, file, sweep }) => {
    const deleting = deferred();
    const resume = deferred();
    const deleteFile = files.deleteFile.bind(files);
    files.deleteFile = async (id) => {
      if (id === file.fileId) { deleting.resolve(); await resume.promise; }
      return deleteFile(id);
    };
    const sweeping = sweep();
    await deleting.promise;
    const creating = assert.rejects(snapshots.create({
      sessionId: session.id, session: toPersistedSessionState(session), modeState: null
    }), (error: unknown) => error instanceof Error && error.message.includes("无法存档：引用的资产不存在") && error.message.includes(file.fileId));
    resume.resolve();
    assert.deepEqual((await sweeping).deletedChatFileIds, [file.fileId]);
    await creating;
    assert.deepEqual(await snapshots.list(session.id), []);
    assert.deepEqual(await persistence.listAssetReferences(), []);
  });
});

test("a snapshot committing the first reference before GC protects that same asset", async () => {
  await withFixture(async (fixture) => {
    const { snapshots, session, sweep } = fixture;
    const creating = snapshots.create({ sessionId: session.id, session: toPersistedSessionState(session), modeState: null });
    const sweeping = sweep();
    await creating;
    const collected = await sweeping;
    assert.deepEqual(collected.deletedChatFileIds, []);
    assert.deepEqual(collected.deletedAudioIds, []);
    await assertMediaPresent(fixture);
  });
});

test("snapshot validation resolves fileRef aliases after a nondestructive asset lookup index upgrade", async () => {
  await withFixture(async (fixture) => {
    const { session, file, audio, dataDir, coordinator, sweep } = fixture;
    const db = new Database(join(dataDir, "assets", "assets.sqlite"));
    try {
      db.exec("DROP INDEX idx_chat_files_ref");
      db.prepare("UPDATE __sqlite_schema_groups SET schema_version = 1 WHERE group_id = 'assets.chat_files'").run();
      const snapshots = new SessionSnapshotStore(dataDir, logger, undefined, coordinator);
      session.internalTranscript = [{
        kind: "tool_result", llmVisible: true, timestampMs: 1, toolCallId: "call-alias", toolName: "browser",
        content: JSON.stringify({ asset_ref: file.fileRef, audio_id: audio.id })
      }];
      await snapshots.create({ sessionId: session.id, session: toPersistedSessionState(session), modeState: null });
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_chat_files_ref'").get());
      await sweep();
      await assertMediaPresent(fixture);
    } finally { db.close(); }
  });
});

test("content and asset ownership roll back together when a reference write or deletion fails", async () => {
  await withFixture(async (fixture) => {
    const { persistence, snapshots, session, dataDir, sweep } = fixture;
    const db = new Database(join(dataDir, "sessions", "sessions.sqlite"));
    try {
      db.exec(`CREATE TRIGGER fail_reference_insert BEFORE INSERT ON session_owned_asset_refs
        BEGIN SELECT RAISE(ABORT, 'reference write failed'); END;`);
      await assert.rejects(persistence.save(toPersistedSessionState(session)), /reference write failed/);
      await assert.rejects(snapshots.create({ sessionId: session.id, session: toPersistedSessionState(session), modeState: null }), /reference write failed/);
      assert.deepEqual(await persistence.loadAll(), []);
      assert.deepEqual(await snapshots.list(session.id), []);
      assert.deepEqual(db.prepare("SELECT * FROM session_asset_owners").all(), []);
      db.exec("DROP TRIGGER fail_reference_insert");
      const snapshot = await archiveAndClear(fixture);
      db.exec(`CREATE TRIGGER fail_owner_delete BEFORE DELETE ON session_asset_owners
        WHEN OLD.owner_kind = 'snapshot' BEGIN SELECT RAISE(ABORT, 'owner delete failed'); END;`);
      await assert.rejects(snapshots.delete(session.id, snapshot.id), /owner delete failed/);
      assert.ok(await snapshots.get(session.id, snapshot.id));
      await sweep();
      await assertMediaPresent(fixture);
    } finally { db.close(); }
  });
});

test("startup backfills missing session and snapshot owners before cleanup and fails closed on unreadable owners", async () => {
  await withFixture(async (fixture) => {
    const { persistence, snapshots, session, dataDir, coordinator, file, audio, sweep } = fixture;
    await persistence.save(toPersistedSessionState(session));
    const snapshot = await snapshots.create({ sessionId: session.id, session: toPersistedSessionState(session), modeState: null });
    const db = new Database(join(dataDir, "sessions", "sessions.sqlite"));
    try {
      db.pragma("foreign_keys = ON");
      db.exec("DELETE FROM session_asset_owners");
      await new SessionPersistence(dataDir, logger, undefined, coordinator).init();
      await new SessionSnapshotStore(dataDir, logger, undefined, coordinator).init();
      const owners = db.prepare("SELECT owner_kind, COUNT(*) AS count FROM session_asset_owners GROUP BY owner_kind ORDER BY owner_kind").all();
      assert.deepEqual(owners, [{ owner_kind: "session", count: 1 }, { owner_kind: "snapshot", count: 1 }]);
      await persistence.remove(session.id);
      await sweep();
      await assertMediaPresent(fixture);
      db.prepare("DELETE FROM session_asset_owners WHERE owner_kind = 'snapshot'").run();
      db.prepare("UPDATE session_snapshots SET payload_json = '{broken' WHERE snapshot_id = ?").run(snapshot.id);
      await assert.rejects(new SessionSnapshotStore(dataDir, logger, undefined, coordinator).init(), SyntaxError);
      assert.deepEqual(db.prepare("SELECT * FROM session_asset_owners").all(), []);
      assert.ok(await fixture.files.getFile(file.fileId));
      assert.ok(await fixture.audioStore.get(audio.id));
    } finally { db.close(); }
  });
});

test("a failed durable ownership read aborts cleanup before deleting any kind of media", async () => {
  await withFixture(async (fixture) => {
    fixture.persistence.listAssetReferences = async () => { throw new Error("reference database unavailable"); };
    await assert.rejects(fixture.sweep(), /reference database unavailable/);
    await assertMediaPresent(fixture);
  });
});

test("admin media projection uses the same typed nested fields as durable ownership", () => {
  const item = createUserTranscriptMessageItem({
    chatType: "private", userId: "owner", senderName: "Owner", timestampMs: 1,
    text: "file_unreferenced aud_unreferenced are only text",
    contentParts: [{ kind: "embedded_message", relation: "reply", parts: [
      { kind: "image", fileId: "nested_image" }, { kind: "audio", audioId: "nested_audio" }
    ] }]
  });
  assert.deepEqual(collectTranscriptMediaIds([item]), { chatFileIds: ["nested_image"], audioIds: ["nested_audio"] });
});

test("deep tool JSON does not overflow reference extraction and mutable entries are not cached", () => {
  const item: InternalToolResultItem = {
    kind: "tool_result", llmVisible: true, timestampMs: 1, toolCallId: "call-1", toolName: "browser",
    content: '{"nested":'.repeat(12_000) + '{"fileId":"deep_file","audio_id":"deep_audio"}' + '}'.repeat(12_000)
  };
  assert.deepEqual(collectTranscriptMediaIds([item]), { chatFileIds: ["deep_file"], audioIds: ["deep_audio"] });
  item.content = '{"file_id":"replacement_file"}';
  assert.deepEqual(collectTranscriptMediaIds([item]), { chatFileIds: ["replacement_file"], audioIds: [] });
});
