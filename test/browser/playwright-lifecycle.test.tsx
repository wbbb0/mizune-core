import test from "node:test";
import assert from "node:assert/strict";
import { PlaywrightBrowserBackend } from "../../src/services/web/browser/playwrightBrowserBackend.ts";
import { createForwardFeatureConfig } from "../helpers/forward-test-support.tsx";
import { createSilentLogger } from "../helpers/browser-test-support.tsx";

const openInput = {
  url: "https://example.com/",
  requestedUrl: "https://example.com/",
  profileId: null,
  storageState: null,
  sessionStorageByOrigin: {},
  persistState: false
};

type FailureStage = "context" | "page" | "navigation" | "snapshot";

function createBackendHarness() {
  const calls = { launch: 0, contextClose: 0, browserClose: 0 };
  const failures = { stage: null as FailureStage | null, contextClose: false, browserClose: false };
  const backend = new PlaywrightBrowserBackend(createForwardFeatureConfig(), createSilentLogger());
  const failAt = (stage: FailureStage) => {
    if (failures.stage === stage) throw new Error(`${stage} failed`);
  };
  Object.assign(backend, {
    async loadPlaywright() {
      return {
        chromium: {
          async launch() {
            calls.launch += 1;
            return {
              async close() {
                calls.browserClose += 1;
                if (failures.browserClose) throw new Error("browser close failed");
              },
              async newContext() {
                failAt("context");
                return {
                  async close() {
                    calls.contextClose += 1;
                    if (failures.contextClose) throw new Error("context close failed");
                  },
                  async newPage() {
                    failAt("page");
                    return {
                      setDefaultTimeout() {},
                      setDefaultNavigationTimeout() {},
                      async goto() { failAt("navigation"); }
                    };
                  }
                };
              }
            };
          }
        }
      };
    },
    async waitForSettledPage() {},
    async restoreSessionStorageForCurrentOrigin() { return false; },
    async captureCurrentOriginSessionStorage() {},
    async captureSnapshot() {
      failAt("snapshot");
      return {
        profileId: null,
        requestedUrl: openInput.requestedUrl,
        resolvedUrl: openInput.url,
        title: "Example",
        contentType: "text/html",
        lines: [], links: [], elements: [], truncated: false
      };
    }
  });
  return { backend, calls, failures };
}

for (const stage of ["context", "page", "navigation", "snapshot"] as const) {
  test(`Playwright open rolls back owned resources after ${stage} failure`, async () => {
    const { backend, calls, failures } = createBackendHarness();
    failures.stage = stage;
    await assert.rejects(backend.open(openInput), new RegExp(`${stage} failed`));
    assert.equal(calls.launch, 1);
    assert.equal(calls.contextClose, stage === "context" ? 0 : 1);
    assert.equal(calls.browserClose, 1);
    await backend.cleanupFailedOpens();
    assert.equal(calls.browserClose, 1);
  });
}

test("Playwright close still releases the browser when its context cannot close", async () => {
  const { backend, calls, failures } = createBackendHarness();
  const opened = await backend.open(openInput);
  assert.equal(calls.browserClose, 0);
  failures.contextClose = true;
  await Promise.all([backend.close(opened.state), backend.close(opened.state)]);
  await backend.close(opened.state);
  assert.equal(calls.contextClose, 1);
  assert.equal(calls.browserClose, 1);
});

test("failed open rollback remains retryable and prevents further browser launches", async () => {
  const { backend, calls, failures } = createBackendHarness();
  failures.stage = "navigation";
  failures.browserClose = true;
  await assert.rejects(backend.open(openInput), /cleanup is pending/);
  await assert.rejects(backend.open(openInput), /Failed to release browsers/);
  assert.equal(calls.launch, 1);
  failures.browserClose = false;
  await backend.cleanupFailedOpens();
  const closedAfterRetry = calls.browserClose;
  await backend.cleanupFailedOpens();
  assert.equal(calls.browserClose, closedAfterRetry);

  failures.stage = null;
  const opened = await backend.open(openInput);
  assert.equal(calls.launch, 2);
  await backend.close(opened.state);
  assert.equal(calls.browserClose, closedAfterRetry + 1);
});

test("Playwright close failure does not cache a rejected close forever", async () => {
  const { backend, calls, failures } = createBackendHarness();
  const opened = await backend.open(openInput);
  failures.browserClose = true;
  await assert.rejects(backend.close(opened.state), /browser close failed/);
  failures.browserClose = false;
  await backend.close(opened.state);
  await backend.close(opened.state);
  assert.equal(calls.browserClose, 2);
});
