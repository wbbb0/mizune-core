import assert from "node:assert/strict";
import { BrowserSessionRuntime } from "../../src/services/web/browser/browserSessionRuntime.ts";
import { BrowserSessionJanitor } from "../../src/services/web/browser/browserSessionJanitor.ts";
import { createForwardFeatureConfig, runCase } from "../helpers/forward-test-support.tsx";
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
      profileId: "profile:private:10001",
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
    ownerSessionId: "private:10001",
    profileId: "profile:private:10001"
  };
}

async function main() {
  await runCase("browser session janitor touches active sessions through the resource registry", async () => {
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

  await runCase("browser session janitor persists and closes expired sessions", async () => {
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
}

void main();
