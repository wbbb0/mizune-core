import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { ContextStore } from "../../src/context/contextStore.ts";
import { ContextIndexCache } from "../../src/context/contextIndexCache.ts";
import { ContextRetrievalService } from "../../src/context/contextRetrievalService.ts";
import type { ContextEmbeddingService } from "../../src/context/contextEmbeddingService.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

const profile = { profileId: "p", instanceName: "test", provider: "test", model: "test", dimension: 3,
  distance: "cosine" as const, textPreprocessVersion: "v1", chunkerVersion: "v1" };
const logger = pino({ level: "silent" });

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "context-snapshots-"));
  const config = createTestAppConfig({ context: { retrieval: { minScore: 0, maxResults: 2, candidateMultiplier: 1, maxSynchronousEmbeddingDocuments: 0 } } });
  const store = new ContextStore(directory, config, logger);
  await store.init();
  const put = (id: string, text = `共同内容 ${id}`) => store.upsertUserSearchChunk({
    itemId: id, userId: "u", sessionId: "s", text, source: "system", createdAt: 100, updatedAt: 100
  });
  const embed = (id: string, vector = [0.1, 0.2, 0.3], profileId = "p") => store.upsertItemEmbedding({
    itemId: id, embeddingProfileId: profileId,
    textHash: store.listUserSearchDocuments("u").find((document) => document.itemId === id)!.embeddingTextHash, vector
  });
  const cache = new ContextIndexCache(store);
  const embedding = { isAvailable: () => true, async embedTexts(texts: string[]) { return { profile, vectors: texts.map(() => [0.1, 0.2, 0.3]) }; } };
  const service = new ContextRetrievalService(config, store, embedding as unknown as ContextEmbeddingService, logger);
  const search = (index: Awaited<ReturnType<ContextIndexCache["get"]>>, excluded: string[] = [], vector = [0.1, 0.2, 0.3]) => index.search({
    userId: "u", queryText: "共同内容", queryVector: vector, excludeItemIds: excluded, limit: 2, candidateMultiplier: 1, minScore: 0
  });
  return { directory, config, store, cache, service, embedding, put, embed, search,
    async cleanup() { store.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("concurrent exclusions share one complete snapshot and filter before candidate limiting", async () => {
  const h = await harness();
  try {
    for (const id of ["a", "b", "c", "d"]) { h.put(id); h.embed(id); }
    let reads = 0;
    const read = h.store.getItemEmbeddings.bind(h.store);
    h.store.getItemEmbeddings = (...args) => { reads++; return read(...args); };
    const [a, b] = await Promise.all([
      h.service.retrieveUserContext({ userId: "u", queryText: "共同内容", excludeItemIds: ["a", "b"] }),
      h.service.retrieveUserContext({ userId: "u", queryText: "共同内容", excludeItemIds: ["c", "d"] })
    ]);
    assert.deepEqual(a.map((item) => item.itemId).sort(), ["c", "d"]);
    assert.deepEqual(b.map((item) => item.itemId).sort(), ["a", "b"]);
    assert.equal(reads, 1);
    await h.service.retrieveUserContext({ userId: "u", queryText: "共同内容" });
    assert.equal(reads, 1, "usage updates and different exclusions must not reread vectors");
  } finally { await h.cleanup(); }
});

test("snapshots remain fixed across profiles, refreshes and resets", async () => {
  const h = await harness();
  try {
    h.put("a"); h.embed("a"); h.embed("a", [1, 0], "other");
    const same1 = h.cache.get("u", "p");
    const same2 = h.cache.get("u", "p");
    assert.equal(same1, same2, "same-signature concurrent builds must share their promise");
    const [old, other] = await Promise.all([same1, h.cache.get("u", "other")]);
    assert.equal((await h.search(old)).length, 1);
    assert.equal((await h.search(other, [], [1, 0])).length, 1);
    h.put("b"); h.embed("b");
    const fresh = await h.cache.get("u", "p");
    assert.equal(fresh.size, 2);
    assert.equal(old.size, 1);
    assert.equal((await h.search(old)).length, 1);
    assert.equal(h.cache.reset("u"), 1);
    assert.equal((await h.search(fresh)).length, 2, "reset must not mutate in-flight snapshot handles");
  } finally { await h.cleanup(); }
});

test("cache signatures cover same-timestamp edits, normalized vectors, deletion, expiry and cleared vectors", async () => {
  const h = await harness();
  try {
    h.put("a"); h.embed("a");
    let current = await h.cache.get("u", "p");
    h.store.recordRetrievedContextItems({ itemIds: ["a"] });
    assert.equal(await h.cache.get("u", "p"), current);
    // JS double inputs and their persisted Float32 values must produce identical cache signatures.
    h.embed("a", [Math.fround(0.1), Math.fround(0.2), Math.fround(0.3)]);
    assert.equal(await h.cache.get("u", "p"), current);
    h.put("a", "同一毫秒的新正文"); h.embed("a");
    let next = await h.cache.get("u", "p");
    assert.notEqual(next, current);
    assert.equal((await h.search(next))[0]?.text, "同一毫秒的新正文");
    current = next;
    h.embed("a", [1, 0, 0]);
    next = await h.cache.get("u", "p");
    assert.notEqual(next, current, "forced re-embedding must invalidate even without a document edit");
    h.store.updateContextItem({ itemId: "a", validTo: Date.now() - 1 });
    assert.equal((await h.cache.get("u", "p")).size, 0);
    h.store.updateContextItem({ itemId: "a", validTo: null });
    assert.equal((await h.cache.get("u", "p")).size, 1);
    h.store.clearEmbeddings({ userId: "u" });
    assert.equal((await h.cache.get("u", "p")).size, 0);
    h.embed("a"); assert.equal((await h.cache.get("u", "p")).size, 1);
    h.store.bulkDeleteContextItems({ userId: "u", sourceType: "chunk" });
    assert.equal((await h.cache.get("u", "p")).size, 0);
  } finally { await h.cleanup(); }
});

test("retrieval and maintenance share snapshots without invalidating active exclusion filters", async () => {
  const h = await harness();
  try {
    for (const id of ["a", "b"]) { h.put(id); h.embed(id); }
    const [result, maintenance] = await Promise.all([
      h.service.retrieveUserContext({ userId: "u", queryText: "共同内容", excludeItemIds: ["a"] }),
      h.service.rebuildUserIndex({ userId: "u", forceReembed: true })
    ]);
    assert.deepEqual(result.map((item) => item.itemId), ["b"]);
    assert.equal(maintenance.indexedCount, 2);
    assert.equal(maintenance.error, undefined);
  } finally { await h.cleanup(); }
});

for (const mode of ["retrieve", "maintenance"] as const) {
  test(`${mode} discards embeddings when source changes during remote embedding`, async () => {
    const h = await harness();
    try {
      h.config.context.retrieval.maxSynchronousEmbeddingDocuments = 2;
      h.put("a"); h.put("b");
      const embed = h.embedding.embedTexts.bind(h.embedding);
      h.embedding.embedTexts = async (texts) => {
        if (texts.some((text) => text === "共同内容 a")) {
          h.put("a", "修改后的正文");
          h.store.bulkDeleteContextItems({ itemId: "b" });
        }
        return embed(texts);
      };
      if (mode === "retrieve") {
        assert.deepEqual(await h.service.retrieveUserContext({ userId: "u", queryText: "query" }), []);
        assert.equal(h.service.getLastDebugReport()?.error, undefined);
      } else {
        const report = await h.service.rebuildUserIndex({ userId: "u" });
        assert.equal(report.embeddedCount, 0);
        assert.equal(report.indexedCount, 0);
        assert.equal(report.error, undefined);
      }
      assert.equal(h.store.getItemEmbeddingMetadata(["a", "b"], "p").size, 0);
    } finally { await h.cleanup(); }
  });
}

for (const fail of [false, true]) {
  test(`retrieval refreshes always context after network wait (${fail ? "failure" : "success"})`, async () => {
    const h = await harness();
    try {
      h.config.context.retrieval.maxResults = 1;
      h.put("search"); h.embed("search");
      const fact = h.store.upsertUserFact({ userId: "u", title: "常驻", content: "需要删除的常驻记忆", kind: "preference", importance: 5 });
      const embed = h.embedding.embedTexts.bind(h.embedding);
      h.embedding.embedTexts = async (texts) => {
        h.store.removeUserFact("u", fact.item.id);
        if (fail) throw new Error("synthetic embedding outage");
        return embed(texts);
      };
      const results = await h.service.retrieveUserContext({ userId: "u", queryText: "共同内容" });
      assert.deepEqual(results.map((item) => item.itemId), fail ? [] : ["search"]);
    } finally { await h.cleanup(); }
  });
}

test("time-based expiry and policy changes invalidate snapshots without vector reads on unchanged usage", async (t) => {
  const h = await harness();
  try {
    h.put("a"); h.embed("a");
    const now = Date.now();
    h.store.updateContextItem({ itemId: "a", validTo: now + 1000 });
    assert.equal((await h.cache.get("u", "p")).size, 1);
    t.mock.method(Date, "now", () => now + 1001);
    assert.equal((await h.cache.get("u", "p")).size, 0, "expiry requires no explicit invalidation callback");
    h.store.updateContextItem({ itemId: "a", validTo: null });
    assert.equal((await h.cache.get("u", "p")).size, 1);
    h.store.updateContextItem({ itemId: "a", sensitivity: "secret" });
    assert.equal((await h.cache.get("u", "p")).size, 0);
  } finally { t.mock.restoreAll(); await h.cleanup(); }
});

test("failed snapshot builds are retryable", async () => {
  const h = await harness();
  try {
    h.put("a"); h.embed("a");
    const original = h.store.getItemEmbeddings.bind(h.store);
    h.store.getItemEmbeddings = () => { throw new Error("temporary read failure"); };
    await assert.rejects(h.cache.get("u", "p"), /temporary read failure/);
    h.store.getItemEmbeddings = original;
    assert.equal((await h.cache.get("u", "p")).size, 1);
  } finally { await h.cleanup(); }
});

test("embedding cache schema upgrade preserves context items and rebuilds derived vectors", async () => {
  const h = await harness();
  try {
    h.put("a"); h.embed("a");
    h.store.close();
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(join(h.directory, "context/context.sqlite"));
    db.prepare("UPDATE __sqlite_schema_groups SET schema_version = 1 WHERE group_id = 'context.embeddings'").run();
    db.close();
    await h.store.init();
    assert.equal(h.store.listUserSearchDocuments("u").length, 1);
    assert.equal(h.store.getItemEmbeddingMetadata(["a"], "p").size, 0);
    h.embed("a");
    assert.equal((await h.cache.get("u", "p")).size, 1);
  } finally { await h.cleanup(); }
});
