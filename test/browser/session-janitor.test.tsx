import test from "node:test";
import assert from "node:assert/strict";
import { BrowserSessionRuntime } from "../../src/services/web/browser/browserSessionRuntime.ts";
import { BrowserSessionJanitor } from "../../src/services/web/browser/browserSessionJanitor.ts";
import { BrowserResourceSync } from "../../src/services/web/browser/browserResourceSync.ts";
import { createForwardFeatureConfig } from "../helpers/forward-test-support.tsx";
import { createSilentLogger } from "../helpers/browser-test-support.tsx";

function createSessionRecord(expiresAt: number) {
  return {
    backend: {
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
    } as any,
    state: { id: 1 },
    snapshot: {
      profileId: "browser_profile_0000000000000001",
      requestedUrl: "https://example.com",
      resolvedUrl: "https://example.com",
      title: "Example",
      contentType: "text/html",
      lines: ["Example"],
      links: [],
      elements: [],
      truncated: false
    } as any,
    expiresAt,
    ownerSessionId: "qqbot:p:10001",
    profileId: "browser_profile_0000000000000001"
  };
}

  test("browser session janitor touches active sessions through the resource registry", async () => {
    const config = createForwardFeatureConfig();
    config.browser.playwright.enabled = true;
    config.browser.sessionTtlMs = 5_000;
    const sessions = new BrowserSessionRuntime(4);
    sessions.set("resource_1", createSessionRecord(100));
    const touched: Array<{ resourceId: string; expiresAt: number }> = [];
    let now = 1_000;
    const originalNow = Date.now;
    Date.now = () => now;

    try {
      const janitor = new BrowserSessionJanitor({
        config,
        logger: createSilentLogger(),
        sessions,
        resourceSync: {
          async touchPage(resourceId: string, session: { expiresAt: number }) {
            touched.push({ resourceId, expiresAt: session.expiresAt });
          },
          async markExpired() {},
          async markMissingAsExpired() {},
          async markClosed() {},
          async registerOpenedPage() {
            return "resource_1";
          },
          async listActivePages() {
            return [];
          },
          logExpiredSessions() {}
        } as any
      }, {
        async persistSessionProfile() {}
      });

      const session = await janitor.requireSession("resource_1");

      assert.equal(session.resourceId, "resource_1");
      assert.deepEqual(touched, [{
        resourceId: "resource_1",
        expiresAt: now + 5_000
      }]);
    } finally {
      Date.now = originalNow;
    }
  });

  test("browser session janitor persists and closes expired sessions", async () => {
    const config = createForwardFeatureConfig();
    config.browser.playwright.enabled = true;
    const sessions = new BrowserSessionRuntime(4);
    const closedStates: unknown[] = [];
    const markedExpired: string[] = [];
    const persistedSessionIds: string[] = [];
    let now = 2_000;
    const originalNow = Date.now;
    Date.now = () => now;

    try {
      sessions.set("resource_1", {
        ...createSessionRecord(now - 1),
        backend: {
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
          async close(state: unknown) {
            closedStates.push(state);
          }
        } as any
      });

      const janitor = new BrowserSessionJanitor({
        config,
        logger: createSilentLogger(),
        sessions,
        resourceSync: {
          async touchPage() {},
          async markExpired(resourceId: string) {
            markedExpired.push(resourceId);
          },
          async markMissingAsExpired() {},
          async markClosed() {},
          async registerOpenedPage() {
            return "resource_1";
          },
          async listActivePages() {
            return [];
          },
          logExpiredSessions() {}
        } as any
      }, {
        async persistSessionProfile(session: { resourceId: string }) {
          persistedSessionIds.push(session.resourceId);
        }
      });

      await janitor.cleanupExpiredSessions();

      assert.deepEqual(persistedSessionIds, ["resource_1"]);
      assert.deepEqual(markedExpired, ["resource_1"]);
      assert.deepEqual(closedStates, [{ id: 1 }]);
      assert.equal(sessions.get("resource_1"), undefined);
    } finally {
      Date.now = originalNow;
    }
  });

function createDisposalHarness(maxSessions = 1) {
  const sessions = new BrowserSessionRuntime(maxSessions);
  const calls = { persist: 0, close: 0, closed: [] as string[], expired: [] as string[] };
  const failure = { persist: false, close: false, markClosed: false };
  const session = sessions.set("resource_1", {
    ...createSessionRecord(Date.now() + 60_000),
    backend: {
      ...createSessionRecord(0).backend,
      async close() {
        calls.close += 1;
        if (failure.close) throw new Error("close failed");
      }
    }
  });
  const janitor = new BrowserSessionJanitor({
    config: createForwardFeatureConfig(),
    logger: createSilentLogger(),
    sessions,
    resourceSync: {
      async markClosed(resourceId: string) {
        if (failure.markClosed) throw new Error("registry failed");
        calls.closed.push(resourceId);
      },
      async markExpired(resourceId: string) { calls.expired.push(resourceId); },
      logExpiredSessions() {}
    } as any
  }, {
    async persistSessionProfile() {
      calls.persist += 1;
      if (failure.persist) throw new Error("profile write failed");
    }
  });
  return { sessions, session, janitor, calls, failure };
}

for (const trigger of ["manual", "expiry", "capacity", "shutdown"] as const) {
  test(`profile persistence failure cannot prevent browser disposal via ${trigger}`, async () => {
    const { sessions, session, janitor, calls, failure } = createDisposalHarness();
    failure.persist = true;
    if (trigger === "manual") {
      await janitor.closeSession(session.resourceId);
    } else if (trigger === "expiry") {
      session.expiresAt = 0;
      await janitor.cleanupExpiredSessions();
    } else if (trigger === "capacity") {
      const release = await janitor.reserveOpen();
      release();
    } else {
      await janitor.closeAllSessions("test_shutdown");
    }
    assert.equal(calls.persist, 1);
    assert.equal(calls.close, 1);
    assert.deepEqual(sessions.all(), []);
    assert.deepEqual(trigger === "manual" ? calls.closed : calls.expired, [session.resourceId]);
  });
}

test("concurrent disposal entry points share a single close and preserve the first terminal status", async () => {
  const { sessions, session, janitor, calls } = createDisposalHarness();
  await Promise.all([
    janitor.closeSession(session.resourceId),
    janitor.closeAllSessions("test_shutdown"),
    janitor.cleanupExpiredSessions()
  ]);
  await janitor.disposeSession(session, "expired");
  assert.equal(calls.persist, 1);
  assert.equal(calls.close, 1);
  assert.deepEqual(calls.closed, [session.resourceId]);
  assert.deepEqual(calls.expired, []);
  assert.deepEqual(sessions.all(), []);
});

test("failed close retains ownership and capacity until a later cleanup succeeds", async () => {
  const { sessions, session, janitor, calls, failure } = createDisposalHarness();
  failure.close = true;
  await assert.rejects(janitor.closeSession(session.resourceId), /close failed/);
  assert.equal(sessions.get(session.resourceId), undefined);
  assert.deepEqual(sessions.pending(), [session]);
  assert.equal(sessions.reserveOpen(), null);
  await assert.rejects(janitor.reserveOpen(), /cleanup is still pending/);
  assert.deepEqual(calls.closed, []);
  assert.deepEqual(calls.expired, []);

  failure.close = false;
  await janitor.cleanupExpiredSessions();
  assert.equal(calls.close, 2);
  assert.deepEqual(calls.closed, [session.resourceId]);
  assert.deepEqual(sessions.all(), []);
  const release = await janitor.reserveOpen();
  release();
});

test("registry failure retries metadata without closing the browser twice", async () => {
  const { sessions, session, janitor, calls, failure } = createDisposalHarness();
  failure.markClosed = true;
  await assert.rejects(janitor.closeSession(session.resourceId), /registry failed/);
  assert.deepEqual(sessions.pending(), [session]);
  failure.markClosed = false;
  await janitor.closeSession(session.resourceId);
  assert.equal(calls.close, 1);
  assert.equal(calls.persist, 1);
  assert.deepEqual(calls.closed, [session.resourceId]);
  assert.deepEqual(sessions.all(), []);
});

test("shutdown reports close failures and retains them for retry", async () => {
  const { sessions, session, janitor, calls, failure } = createDisposalHarness(2);
  let otherClosed = false;
  sessions.set("resource_2", {
    ...createSessionRecord(Date.now() + 60_000),
    backend: { ...session.backend, async close() { otherClosed = true; } }
  });
  failure.close = true;
  await assert.rejects(janitor.closeAllSessions("test_shutdown"), /remain tracked for retry/);
  assert.equal(otherClosed, true);
  assert.deepEqual(sessions.pending(), [session]);
  assert.deepEqual(calls.expired, ["resource_2"]);
  failure.close = false;
  await janitor.closeAllSessions("test_shutdown_retry");
  assert.deepEqual(sessions.all(), []);
});

test("listing pages cannot mark a still-owned pending disposal as expired", async () => {
  const { sessions, session } = createDisposalHarness();
  const statuses: string[] = [];
  const resourceSync = new BrowserResourceSync({
    async list() {
      return [{
        resourceId: session.resourceId,
        status: "active",
        browserPage: { requestedUrl: "https://example.com/", resolvedUrl: "https://example.com/" }
      }];
    },
    async markStatus(_resourceId: string, status: string) { statuses.push(status); }
  } as any, createSilentLogger());
  sessions.beginDisposal(session);
  assert.deepEqual(await resourceSync.listActivePages(sessions), []);
  assert.deepEqual(statuses, []);
  sessions.completeDisposal(session);
  await resourceSync.listActivePages(sessions);
  assert.deepEqual(statuses, ["expired"]);
});
