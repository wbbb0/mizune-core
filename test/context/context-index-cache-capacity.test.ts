import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { ContextStore } from "../../src/context/contextStore.ts";
import { ContextIndexCache } from "../../src/context/contextIndexCache.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

test("context index snapshots are globally bounded and evicted users rebuild on demand", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-index-lru-"));
  const config = createTestAppConfig();
  const store = new ContextStore(directory, config, pino({ level: "silent" }));
  await store.init();
  try {
    const cache = new ContextIndexCache(store, 2);
    for (const userId of ["u1", "u2", "u3"]) {
      store.upsertUserSearchChunk({ itemId: userId, userId, sessionId: "s", text: "text", source: "system", createdAt: 1, updatedAt: 1 });
      const index = await cache.get(userId, "profile");
      assert.equal(index.size, 0);
    }
    assert.equal(cache.reset("u1"), 0, "least-recently-used user was evicted");
    assert.equal(cache.reset("u2"), 1);
    assert.equal(cache.reset(), 1);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
