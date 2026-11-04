import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { AssetsDatabase } from "../../src/data/assets/assetsDatabase.ts";
import { SqliteMediaSourceRepository } from "../../src/services/workspace/mediaSources/repository.ts";
import { MediaImportService } from "../../src/services/workspace/mediaSources/service.ts";
import { createMemoryMediaSources } from "../helpers/media-import-fixtures.ts";
import type { ChatFileRecord } from "../../src/services/workspace/types.ts";

const scope = { connectionId: "bot", sessionId: "bot:g:1" };
const input = { kind: "image" as const, source: "https://example.invalid/private?token=SECRET" };
function asset(id = "file_cached"): ChatFileRecord {
  return { fileId: id, fileRef: `${id}.png`, kind: "image", origin: "chat_message", chatFilePath: `${id}.png`,
    sourceName: "测试.png", mimeType: "image/png", sizeBytes: 1, createdAtMs: 1, sourceContext: {}, caption: null,
    captionStatus: "missing", captionUpdatedAtMs: null, captionModelRef: null, captionError: null };
}

test("failed source survives restart, respects scope and backs off from failure completion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "media-source-recovery-"));
  let database = new AssetsDatabase(dir, pino({ level: "silent" }));
  let now = 1000;
  let imports = 0;
  try {
    let sources = new SqliteMediaSourceRepository(database, () => now);
    const failed = new MediaImportService({ sources, now: () => now, refresh: async () => null,
      files: { getFile: async () => null, isFileAvailable: async () => false,
        importRemoteSource: async () => { imports++; now += 40_000; throw new Error("failure with secret URL"); } } });
    const first = await failed.import(scope, input);
    assert.equal(first.resolution, null);
    assert.equal((await sources.get(scope, first.ref))?.nextRetryAt, 71_000);
    assert.equal(await failed.resolve(scope, first.ref), null);
    assert.equal(imports, 1);
    database.close();
    database = new AssetsDatabase(dir, pino({ level: "silent" }));
    sources = new SqliteMediaSourceRepository(database, () => now);
    now = 71_001;
    let patched = 0;
    const repaired = new MediaImportService({ sources, now: () => now, refresh: async () => null,
      onResolved: () => { patched++; }, files: { getFile: async () => asset(), isFileAvailable: async () => true,
        importRemoteSource: async () => { imports++; return asset(); } } });
    assert.equal(await repaired.resolve({ ...scope, sessionId: "bot:g:other" }, first.ref), null);
    assert.equal(await repaired.resolve({ ...scope, connectionId: "other" }, first.ref), null);
    assert.equal(imports, 1);
    assert.equal((await repaired.resolve(scope, first.ref))?.file.fileId, "file_cached");
    assert.equal((await repaired.resolve(scope, first.ref))?.file.fileId, "file_cached");
    assert.equal(imports, 2);
    assert.equal(patched, 2, "cache hits must repair persisted pending parts too");
  } finally { database.close(); await rm(dir, { recursive: true, force: true }); }
});

test("an expired OneBot image URL gets one locator refresh and returns a real asset", async () => {
  const sources = createMemoryMediaSources();
  const calls: string[] = [];
  let refreshes = 0;
  const service = new MediaImportService({ sources,
    refresh: async (actualScope, locator) => { assert.deepEqual(actualScope, scope); assert.equal(locator.id, "123"); refreshes++; return "https://example.invalid/fresh"; },
    files: { getFile: async () => null, isFileAvailable: async () => false, importRemoteSource: async request => {
      calls.push(request.source); if (calls.length === 1) throw new Error("expired"); return asset();
    } } });
  const result = await service.import(scope, { ...input, locator: { kind: "onebot_message", id: "123", imageIndex: 0 } });
  assert.equal(result.resolution?.file.fileId, "file_cached");
  assert.equal(refreshes, 1);
  assert.deepEqual(calls, [input.source, "https://example.invalid/fresh"]);
});

test("concurrent requests coalesce and a canceled caller does not cancel another waiter", async () => {
  const sources = createMemoryMediaSources();
  const record = await sources.register(scope, input);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  const service = new MediaImportService({ sources, refresh: async () => null,
    files: { getFile: async () => null, isFileAvailable: async () => false, importRemoteSource: async () => {
      calls++; started(); await gate; return asset();
    } } });
  const abort = new AbortController();
  const canceled = service.resolve(scope, record.id, abort.signal);
  const retained = service.resolve(scope, record.id);
  await ready;
  abort.abort(new Error("caller canceled"));
  await assert.rejects(canceled, /caller canceled/);
  assert.equal(calls, 1);
  release();
  assert.equal((await retained)?.file.fileId, "file_cached");
});

test("media import slots remain bounded while queued requests and new callers compete", async () => {
  const sources = createMemoryMediaSources();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let active = 0, peak = 0;
  const service = new MediaImportService({ sources, refresh: async () => null,
    files: { getFile: async () => null, isFileAvailable: async () => false, importRemoteSource: async () => {
      active++; peak = Math.max(active, peak); await gate; await Promise.resolve(); active--; return asset();
    } } });
  const tasks = Array.from({ length: 20 }, (_, i) => service.import(scope, { ...input, source: `https://example.invalid/${i}` }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(peak, 4);
  release();
  await Promise.all([...tasks, service.import(scope, { ...input, source: "https://example.invalid/new" })]);
  assert.equal(peak, 4);
});

test("reclaimed assets are imported again rather than trusted from stale success state", async () => {
  const sources = createMemoryMediaSources();
  let calls = 0;
  const service = new MediaImportService({ sources, refresh: async () => null,
    files: { getFile: async () => null, isFileAvailable: async () => false, importRemoteSource: async () => asset(`file_${++calls}`) } });
  const first = await service.import(scope, input);
  assert.equal((await service.resolve(scope, first.ref))?.file.fileId, "file_2");
});

test("freshly registered URLs cannot be overwritten by a stale failing attempt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "media-source-version-"));
  const db = new AssetsDatabase(dir, pino({ level: "silent" }));
  try {
    const sources = new SqliteMediaSourceRepository(db);
    const locator = { kind: "onebot_message" as const, id: "123", imageIndex: 0 };
    const stale = await sources.register(scope, { ...input, locator });
    const fresh = await sources.register(scope, { ...input, locator, source: "https://example.invalid/fresh" });
    stale.failures = 3; stale.nextRetryAt = Number.MAX_SAFE_INTEGER;
    await sources.save(stale);
    const stored = await sources.get(scope, fresh.id);
    assert.equal(stored?.input.source, "https://example.invalid/fresh");
    assert.equal(stored?.failures, 0);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});
