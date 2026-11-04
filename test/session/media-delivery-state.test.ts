import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import pino from "pino";
import { SessionPersistence } from "../../src/conversation/session/sessionPersistence.ts";
import { createSessionState, restoreSessionState, toPersistedSessionState } from "../../src/conversation/session/sessionStateFactory.ts";
import { sessionDataDomain } from "../../src/conversation/session/sessionDataModel.ts";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { diffSessionStreamEvents, type WebSessionStreamSnapshot } from "../../src/internalApi/application/webSessionStream.ts";
import type { InternalTranscriptItem } from "../../src/conversation/session/sessionTypes.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

type Media = Extract<InternalTranscriptItem, { kind: "outbound_media_message" }>;
function media(id: string, deliveryStatus: Media["deliveryStatus"]): Media {
  return { id, groupId: "response", runtimeExcluded: false, kind: "outbound_media_message", role: "assistant", llmVisible: false,
    delivery: "qq_official", deliveryStatus, deliveryUpdatedAtMs: 1000, mediaKind: "image", fileId: "asset",
    fileRef: "image.png", sourceName: "image.png", chatFilePath: null, sourcePath: null,
    messageId: deliveryStatus === "accepted" ? "message-id" : null, toolName: "asset_send_to_chat", timestampMs: 1000 };
}
const logger = pino({ level: "silent" });

async function temporary(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "media-delivery-state-"));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("real SQLite v12 media migration records platform acceptance and updates the stored item hash", async () => temporary(async dir => {
  const persistence = new SessionPersistence(dir, logger);
  const session = createSessionState({ id: "qq_official.app:p:user", type: "private", source: "qq_official" });
  session.internalTranscript = [media("legacy-media", "accepted")];
  await persistence.save(toPersistedSessionState(session));
  const path = join(dir, "sessions", "sessions.sqlite");
  const db = new Database(path);
  const original = db.prepare("SELECT item_json FROM session_transcript_items WHERE item_id = ?").get("legacy-media") as { item_json: string };
  const legacy = JSON.parse(original.item_json);
  delete legacy.deliveryStatus; delete legacy.deliveryUpdatedAtMs;
  db.prepare("UPDATE session_transcript_items SET item_json = ?, item_hash = ? WHERE item_id = ?")
    .run(JSON.stringify(legacy), "old-hash", "legacy-media");
  db.prepare("UPDATE __sqlite_schema_groups SET schema_version = 12 WHERE group_id = ?").run(sessionDataDomain.tableGroup);
  db.close();
  const migrated = new SessionPersistence(dir, logger);
  const [loaded] = await migrated.loadAll();
  assert.ok(loaded);
  const item = loaded.internalTranscript[0];
  assert.equal(item?.id, "legacy-media");
  assert.equal(item?.kind, "outbound_media_message");
  if (item?.kind === "outbound_media_message") {
    assert.equal(item.deliveryStatus, "accepted");
    assert.equal(item.deliveryUpdatedAtMs, 1000);
  }
  const verify = new Database(path, { readonly: true });
  const row = verify.prepare("SELECT item_json, item_hash FROM session_transcript_items WHERE item_id = ?").get("legacy-media") as { item_json: string; item_hash: string };
  assert.equal(row.item_hash, createHash("sha256").update(row.item_json).digest("hex"));
  const version = verify.prepare("SELECT schema_version FROM __sqlite_schema_groups WHERE group_id = ?").get(sessionDataDomain.tableGroup) as { schema_version: number };
  assert.equal(version.schema_version, sessionDataDomain.schemaVersion);
  verify.close();
  await migrated.save(loaded);
  const reloaded = await new SessionPersistence(dir, logger).loadAll();
  assert.deepEqual(reloaded[0]?.internalTranscript, loaded.internalTranscript);
}));

test("restoring queued media cancels it and submitting media becomes unknown without altering terminal receipts", async () => temporary(async dir => {
  const session = createSessionState({ id: "qq_official.app:p:user", type: "private", source: "qq_official" });
  const statuses: Media["deliveryStatus"][] = ["queued", "sending", "accepted", "failed", "cancelled", "unknown"];
  session.internalTranscript = statuses.map((status, index) => media(`media-${index}`, status));
  const saved = toPersistedSessionState(session);
  const restored = restoreSessionState(saved);
  assert.deepEqual(restored.internalTranscript.map(item => item.kind === "outbound_media_message" && item.deliveryStatus),
    ["cancelled", "unknown", "accepted", "failed", "cancelled", "unknown"]);
  assert.deepEqual(restored.internalTranscript.map(item => item.id), saved.internalTranscript.map(item => item.id));
  assert.deepEqual(restored.internalTranscript.slice(2), saved.internalTranscript.slice(2));
  const persistence = new SessionPersistence(dir, logger);
  await persistence.save(toPersistedSessionState(restored));
  const [loaded] = await persistence.loadAll();
  assert.ok(loaded);
  assert.deepEqual(restoreSessionState(loaded).internalTranscript, restored.internalTranscript);
}));

function snapshot(item: InternalTranscriptItem): WebSessionStreamSnapshot {
  return { sessionId: "qq_official.app:p:user", modeId: "assistant", mutationEpoch: 0,
    transcript: [item], lastActiveAt: 1000, phase: { kind: "idle" }, activeAssistantResponseText: null };
}

test("media status transitions emit same-ID SSE patches and cannot revive a cleared or terminal delivery", () => {
  const manager = new SessionManager(createTestAppConfig());
  const sessionId = "qq_official.app:p:user";
  manager.ensureSession({ id: sessionId, type: "private", source: "qq_official" });
  manager.appendInternalTranscript(sessionId, media("delivery", "queued"));
  const queued = manager.getMediaDelivery(sessionId, "delivery")!;
  assert.equal(manager.patchMediaDelivery(sessionId, "delivery", { deliveryStatus: "sending" }), true);
  const sending = manager.getMediaDelivery(sessionId, "delivery")!;
  assert.equal(queued.deliveryStatus, "queued");
  assert.notEqual(queued, sending);
  assert.equal(manager.patchMediaDelivery(sessionId, "delivery", { deliveryStatus: "unknown",
    deliveryError: { stage: "message", code: "transport", message: "提交结果未知" } }), true);
  const unknown = manager.getMediaDelivery(sessionId, "delivery")!;
  const events = diffSessionStreamEvents(snapshot(sending), snapshot(unknown));
  assert.equal(events.length, 1);
  const event = events[0]!;
  assert.equal(event.type, "transcript_item_patched");
  if (event.type === "transcript_item_patched") {
    assert.equal(event.itemId, "delivery");
    assert.equal(event.patch.deliveryStatus, "unknown");
    assert.deepEqual(event.patch.deliveryError, unknown.deliveryError);
    assert.deepEqual({ ...sending, ...event.patch }, unknown);
  }
  assert.equal(manager.patchMediaDelivery(sessionId, "delivery", { deliveryStatus: "accepted", messageId: "late" }), false);
  manager.clearSession(sessionId);
  assert.equal(manager.patchMediaDelivery(sessionId, "delivery", { deliveryStatus: "accepted", messageId: "late" }), false);
  assert.equal(manager.getMediaDelivery(sessionId, "delivery"), undefined);
  assert.equal(manager.getSession(sessionId).internalTranscript.length, 0);
});
