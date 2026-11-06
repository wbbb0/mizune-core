import test from "node:test";
import assert from "node:assert/strict";
import { BrowserSessionRuntime } from "../../src/services/web/browser/browserSessionRuntime.ts";
import type { BrowserBackend } from "../../src/services/web/browser/types.ts";

function createSessionInit(resourceId: string, expiresAt: number, profileId: string | null = null) {
  const backend: BrowserBackend = {
    name: "playwright",
    async open() { throw new Error("not used"); },
    async interact() { throw new Error("not used"); },
    async captureScreenshot() { throw new Error("not used"); },
    async persistState() { return { storageState: null, sessionStorageByOrigin: {} }; },
    async close() {},
    async cleanupFailedOpens() {}
  };
  return {
    backend,
    state: { resourceId },
    snapshot: {
      profileId,
      requestedUrl: `https://example.com/${resourceId}`,
      resolvedUrl: `https://example.com/${resourceId}`,
      title: null,
      contentType: "text/html",
      lines: [],
      links: [],
      elements: [],
      truncated: false
    },
    expiresAt,
    ownerSessionId: "qqbot:p:owner",
    profileId
  };
}

test("session disposal removes a page from active use but retains ownership until completion", () => {
  const runtime = new BrowserSessionRuntime(3);
  const session = runtime.set("page_1", createSessionInit("page_1", 100, "profile-1"));
  assert.equal(runtime.touch("page_1", 200)?.expiresAt, 200);
  assert.equal(runtime.findByProfileId("profile-1"), session);

  runtime.beginDisposal(session);
  runtime.beginDisposal(session);
  assert.equal(runtime.get("page_1"), undefined);
  assert.equal(runtime.findByProfileId("profile-1"), null);
  assert.equal(runtime.touch("page_1", 300), null);
  assert.deepEqual(runtime.pending(), [session]);
  assert.deepEqual(runtime.all(), [session]);

  runtime.completeDisposal(session);
  runtime.completeDisposal(session);
  assert.deepEqual(runtime.all(), []);
});

test("session capacity includes opening reservations and resources awaiting disposal", () => {
  const runtime = new BrowserSessionRuntime(2);
  const session = runtime.set("page_1", createSessionInit("page_1", 100));
  const release = runtime.reserveOpen();
  assert.ok(release);
  assert.equal(runtime.reserveOpen(), null);

  runtime.beginDisposal(session);
  assert.equal(runtime.reserveOpen(), null);
  runtime.completeDisposal(session);
  const releaseSecond = runtime.reserveOpen();
  assert.ok(releaseSecond);
  assert.equal(runtime.reserveOpen(), null);

  release();
  release();
  const releaseThird = runtime.reserveOpen();
  assert.ok(releaseThird);
  assert.equal(runtime.reserveOpen(), null);
  releaseSecond();
  releaseThird();
});

test("expired sessions remain tracked while unaffected pages stay active", () => {
  const runtime = new BrowserSessionRuntime(4);
  const first = runtime.set("page_1", createSessionInit("page_1", 100));
  const second = runtime.set("page_2", createSessionInit("page_2", 200));
  const third = runtime.set("page_3", createSessionInit("page_3", 300));

  assert.deepEqual(runtime.collectExpired(200), [first, second]);
  assert.deepEqual(runtime.collectExpired(200), []);
  assert.deepEqual(runtime.pending(), [first, second]);
  assert.deepEqual(runtime.values(), [third]);
  assert.equal(runtime.all().length, 3);
});

test("registering a duplicate resource cannot overwrite an owned browser", () => {
  const runtime = new BrowserSessionRuntime(2);
  const session = runtime.set("page_1", createSessionInit("page_1", 100));
  assert.throws(() => runtime.set("page_1", createSessionInit("replacement", 200)), /already tracked/);
  assert.equal(runtime.get("page_1"), session);
  runtime.beginDisposal(session);
  assert.throws(() => runtime.set("page_1", createSessionInit("replacement", 200)), /already tracked/);
  assert.equal(runtime.findPendingDisposal("page_1"), session);
});
