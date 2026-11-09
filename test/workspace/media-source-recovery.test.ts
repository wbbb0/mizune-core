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
      files: { deleteFile: async () => true, getFile: async () => null, isFileAvailable: async () => false,
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
      onResolved: () => { patched++; }, files: { deleteFile: async () => true, getFile: async () => asset(), isFileAvailable: async () => true,
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
    files: { deleteFile: async () => true, getFile: async () => null, isFileAvailable: async () => false, importRemoteSource: async request => {
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
    files: { deleteFile: async () => true, getFile: async () => null, isFileAvailable: async () => false, importRemoteSource: async () => {
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
    files: { deleteFile: async () => true, getFile: async () => null, isFileAvailable: async () => false, importRemoteSource: async () => {
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
    files: { deleteFile: async () => true, getFile: async () => null, isFileAvailable: async () => false, importRemoteSource: async () => asset(`file_${++calls}`) } });
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

function deferredImport() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function waitImport(predicate: () => boolean) {
  for (let tries = 0; !predicate(); tries++) {
    if (tries > 1000) throw new Error("condition not reached");
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

test("last import owner cancellation removes queued recovery and neither retries nor publishes late work", async () => {
  const sources = createMemoryMediaSources();
  const records = await Promise.all(Array.from({ length: 5 }, (_, index) => sources.register(scope, { ...input, source: `https://synthetic.invalid/${index}` })));
  const gate = deferredImport();
  const signals: AbortSignal[] = [];
  const removed: string[] = [];
  let published = 0;
  const service = new MediaImportService({ sources, refresh: async () => null, onResolved: () => { published++; },
    files: { getFile: async () => null, isFileAvailable: async () => false, deleteFile: async id => { removed.push(id); return true; },
      importRemoteSource: async request => { signals.push(request.signal!); await gate.promise; return asset(`file_${signals.indexOf(request.signal!)}`); }
    }
  });
  const controller = new AbortController();
  const attempts = records.map(record => service.resolve(scope, record.id, controller.signal));
  const failures = attempts.map(promise => assert.rejects(promise, /cancel all/));
  await waitImport(() => signals.length === 4);
  controller.abort(new Error("cancel all"));
  await Promise.all(failures);
  assert.equal(signals.every(signal => signal.aborted), true);
  gate.resolve();
  await service.stop();
  assert.equal(signals.length, 4);
  assert.equal(removed.length, 4);
  assert.equal(published, 0);
  for (const record of records) {
    assert.equal((await sources.get(scope, record.id))?.failures, 0);
    assert.equal((await sources.get(scope, record.id))?.assetId, null);
  }
});

test("late canceled recovery cannot delete a replacement flight or publish its old file", async () => {
  const sources = createMemoryMediaSources();
  const record = await sources.register(scope, input);
  const oldGate = deferredImport(), newGate = deferredImport();
  const removed: string[] = [], published: string[] = [];
  let calls = 0;
  const service = new MediaImportService({ sources, refresh: async () => null, onResolved: (_scope, result) => { published.push(result.file.fileId); },
    files: { getFile: async () => null, isFileAvailable: async () => false, deleteFile: async id => { removed.push(id); return true; },
      importRemoteSource: async () => { const call = ++calls; await (call === 1 ? oldGate : newGate).promise; return asset(`file_${call}`); }
    }
  });
  const controller = new AbortController();
  const old = service.resolve(scope, record.id, controller.signal);
  await waitImport(() => calls === 1);
  controller.abort(new Error("old cancelled"));
  await assert.rejects(old, /old cancelled/);
  const next = service.resolve(scope, record.id);
  await waitImport(() => calls === 2);
  oldGate.resolve();
  await waitImport(() => removed.length === 1);
  const shared = service.resolve(scope, record.id);
  newGate.resolve();
  assert.equal((await next)?.file.fileId, "file_2");
  assert.equal((await shared)?.file.fileId, "file_2");
  assert.equal(calls, 2);
  assert.deepEqual(removed, ["file_1"]);
  assert.deepEqual(published, ["file_2"]);
  assert.equal((await sources.get(scope, record.id))?.assetId, "file_2");
  await service.stop();
});

test("recovery's total deadline includes waiting behind all four actual workers", async () => {
  const sources = createMemoryMediaSources();
  const records = await Promise.all(Array.from({ length: 5 }, (_, index) => sources.register(scope, { ...input, source: `https://synthetic.invalid/deadline/${index}` })));
  const gate = deferredImport();
  let calls = 0;
  const service = new MediaImportService({ sources, refresh: async () => null, operationTimeoutMs: 20,
    files: { getFile: async () => null, isFileAvailable: async () => false, deleteFile: async () => true,
      importRemoteSource: async () => { calls++; await gate.promise; return asset(); }
    }
  });
  const tasks = records.map(record => service.resolve(scope, record.id));
  assert.deepEqual(await Promise.all(tasks), [null, null, null, null, null]);
  assert.equal(calls, 4, "expired queued work must never start after its deadline");
  gate.resolve();
  await service.stop();
});

test("large inbound batches retain registered pending handles when recovery capacity is exhausted", async () => {
  const sources = createMemoryMediaSources();
  const gate = deferredImport();
  let calls = 0;
  const returned: Array<{ ref: string; resolution: unknown }> = [];
  const service = new MediaImportService({ sources, refresh: async () => null,
    files: { getFile: async () => null, isFileAvailable: async () => false, deleteFile: async () => true,
      importRemoteSource: async () => { calls++; await gate.promise; return asset(`file_${calls}`); }
    }
  });
  const tasks = Array.from({ length: 270 }, (_, index) => service.import(scope, { ...input, source: `https://synthetic.invalid/capacity/${index}` }).then(result => { returned.push(result); return result; }));
  await waitImport(() => returned.length === 14);
  assert.equal(calls, 4);
  assert.equal(returned.every(result => result.resolution === null && result.ref.startsWith("media_")), true);
  gate.resolve();
  const all = await Promise.all(tasks);
  assert.equal(all.length, 270);
  assert.equal(all.every(result => Boolean(result.ref)), true);
  await service.stop();
});

test("cancelling a source repository save leaves version, retry and asset state unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "media-source-cancelled-save-"));
  const database = new AssetsDatabase(dir, pino({ level: "silent" }));
  try {
    const sources = new SqliteMediaSourceRepository(database);
    const record = await sources.register(scope, input);
    const original = structuredClone(record);
    record.failures = 4; record.nextRetryAt = Number.MAX_SAFE_INTEGER; record.assetId = "file_stale";
    const controller = new AbortController(); controller.abort(new Error("source write cancelled"));
    await assert.rejects(sources.save(record, controller.signal), /source write cancelled/);
    assert.deepEqual(await sources.get(scope, record.id), original);
  } finally { database.close(); await rm(dir, { recursive: true, force: true }); }
});

test("stop aborts pre-admission owners and rejects later imports before registration", async () => {
  const original = createMemoryMediaSources();
  const gate = deferredImport();
  let registered = 0, downloaded = 0;
  const sources = { ...original, async register(actualScope: typeof scope, actualInput: typeof input, signal?: AbortSignal) {
    registered++;
    await gate.promise;
    return original.register(actualScope, actualInput, signal);
  } };
  const service = new MediaImportService({ sources, refresh: async () => null,
    files: { getFile: async () => null, isFileAvailable: async () => false, deleteFile: async () => true,
      importRemoteSource: async () => { downloaded++; return asset(); }
    }
  });
  const importing = service.import(scope, input);
  await waitImport(() => registered === 1);
  const rejected = assert.rejects(importing, /已关闭/);
  await service.stop();
  await rejected;
  await assert.rejects(service.import(scope, input), /已关闭/);
  assert.equal(registered, 1);
  gate.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(downloaded, 0);
  assert.equal((service as unknown as { owners: Set<unknown> }).owners.size, 0);
});

test("stop also detaches owners blocked in a source scope lookup", async () => {
  const original = createMemoryMediaSources();
  const record = await original.register(scope, input);
  const gate = deferredImport();
  let reads = 0, downloads = 0;
  const service = new MediaImportService({ sources: { ...original, async get(actualScope, ref) { reads++; await gate.promise; return original.get(actualScope, ref); } }, refresh: async () => null,
    files: { getFile: async () => null, isFileAvailable: async () => false, deleteFile: async () => true,
      importRemoteSource: async () => { downloads++; return asset(); }
    }
  });
  const resolving = service.resolve(scope, record.id);
  await waitImport(() => reads === 1);
  const rejected = assert.rejects(resolving, /已关闭/);
  await service.stop();
  await rejected;
  gate.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(downloads, 0);
});
