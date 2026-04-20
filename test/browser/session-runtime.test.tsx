import assert from "node:assert/strict";
import { BrowserSessionRuntime } from "../../src/services/web/browser/browserSessionRuntime.ts";
import type { BrowserBackend } from "../../src/services/web/browser/types.ts";
import { runCase } from "../helpers/forward-test-support.tsx";

function createSnapshot(url: string) {
  return {
    profileId: null,
    requestedUrl: url,
    resolvedUrl: url,
    title: null,
    contentType: "text/html",
    lines: [],
    links: [],
    elements: [],
    truncated: false
  };
}

function createSessionInit(resourceId: string, expiresAt: number, profileId: string | null = null) {
  const backend: BrowserBackend = {
    name: "playwright",
    async open() {
      throw new Error("not used");
    },
    async interact() {
      throw new Error("not used");
    },
    async captureScreenshot() {
      throw new Error("not used");
    },
    async persistState() {
      return {
        storageState: null,
        sessionStorageByOrigin: {}
      };
    },
    async close() {}
  };

  return {
    backend,
    state: { resourceId },
    snapshot: createSnapshot(`https://example.com/${resourceId}`),
    expiresAt,
    ownerSessionId: "qqbot:p:owner",
    profileId
  };
}

async function main() {
  await runCase("session runtime supports basic get/touch/find/delete lifecycle", async () => {
    const runtime = new BrowserSessionRuntime(3);
    runtime.set("browser_page_1", createSessionInit("browser_page_1", 100, "profile-1"));

    const found = runtime.get("browser_page_1");
    assert.ok(found);
    assert.equal(found?.expiresAt, 100);

    const touched = runtime.touch("browser_page_1", 200);
    assert.equal(touched?.expiresAt, 200);

    const byProfile = runtime.findByProfileId("profile-1");
    assert.equal(byProfile?.resourceId, "browser_page_1");

    const removed = runtime.delete("browser_page_1");
    assert.equal(removed?.resourceId, "browser_page_1");
    assert.equal(runtime.get("browser_page_1"), undefined);
  });

  await runCase("session runtime evicts oldest sessions when max is exceeded", async () => {
    const runtime = new BrowserSessionRuntime(2);

    const firstEvicted = runtime.set("browser_page_1", createSessionInit("browser_page_1", 100));
    assert.deepEqual(firstEvicted, []);
    runtime.set("browser_page_2", createSessionInit("browser_page_2", 200));
    const evicted = runtime.set("browser_page_3", createSessionInit("browser_page_3", 300));

    assert.equal(evicted.length, 1);
    assert.equal(evicted[0]?.resourceId, "browser_page_1");
    assert.equal(runtime.get("browser_page_1"), undefined);
    assert.equal(runtime.get("browser_page_2")?.resourceId, "browser_page_2");
    assert.equal(runtime.get("browser_page_3")?.resourceId, "browser_page_3");
  });

  await runCase("session runtime collectExpired only removes expired entries", async () => {
    const runtime = new BrowserSessionRuntime(4);
    runtime.set("browser_page_1", createSessionInit("browser_page_1", 100));
    runtime.set("browser_page_2", createSessionInit("browser_page_2", 200));
    runtime.set("browser_page_3", createSessionInit("browser_page_3", 300));

    const expired = runtime.collectExpired(200);
    assert.deepEqual(expired.map((item) => item.resourceId), ["browser_page_1", "browser_page_2"]);
    assert.equal(runtime.get("browser_page_1"), undefined);
    assert.equal(runtime.get("browser_page_2"), undefined);
    assert.equal(runtime.get("browser_page_3")?.resourceId, "browser_page_3");

    const cleared = runtime.clear();
    assert.deepEqual(cleared.map((item) => item.resourceId), ["browser_page_3"]);
    assert.equal(runtime.values().length, 0);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
