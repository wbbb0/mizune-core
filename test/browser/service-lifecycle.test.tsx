import test from "node:test";
import assert from "node:assert/strict";
import { BrowserService, type BrowserServiceDeps } from "../../src/services/web/browser/browserService.ts";
import { BrowserSessionRuntime } from "../../src/services/web/browser/browserSessionRuntime.ts";
import { createForwardFeatureConfig } from "../helpers/forward-test-support.tsx";
import { createSilentLogger } from "../helpers/browser-test-support.tsx";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function createServiceHarness() {
  const config = createForwardFeatureConfig();
  config.browser.playwright.enabled = true;
  const sessions = new BrowserSessionRuntime(1);
  const calls = { open: 0, close: 0, register: 0, touch: 0, closed: [] as string[], expired: [] as string[] };
  const failure = { open: false, register: false, close: false };
  const openingStarted = deferred();
  const control = { openGate: Promise.resolve() };
  const service = new BrowserService({
    config,
    logger: createSilentLogger(),
    sessions,
    resolveSearchRef: () => null,
    profileStore: {} as BrowserServiceDeps["profileStore"],
    assetStore: {} as BrowserServiceDeps["assetStore"],
    playwrightBackend: {
      name: "playwright",
      async open(input) {
        calls.open += 1;
        openingStarted.resolve();
        await control.openGate;
        if (failure.open) throw new Error("open failed");
        return {
          state: { url: input.url },
          snapshot: {
            profileId: null,
            requestedUrl: input.requestedUrl,
            resolvedUrl: input.url,
            title: "Example",
            contentType: "text/html",
            lines: [], links: [], elements: [], truncated: false
          }
        };
      },
      async interact() { throw new Error("not used"); },
      async captureScreenshot() { throw new Error("not used"); },
      async persistState() { return { storageState: null, sessionStorageByOrigin: {} }; },
      async close() {
        calls.close += 1;
        if (failure.close) throw new Error("close failed");
      },
      async cleanupFailedOpens() {}
    },
    resourceSync: {
      async registerOpenedPage() {
        calls.register += 1;
        if (failure.register) throw new Error("registration failed");
        return `resource_${calls.register}`;
      },
      async markClosed(resourceId: string) { calls.closed.push(resourceId); },
      async markExpired(resourceId: string) { calls.expired.push(resourceId); },
      async markMissingAsExpired() {},
      async touchPage() { calls.touch += 1; },
      async listActivePages() { return []; },
      logExpiredSessions() {}
    } as unknown as BrowserServiceDeps["resourceSync"]
  });
  return { service, sessions, calls, failure, control, openingStarted };
}

for (const stage of ["open", "register"] as const) {
  test(`browser ${stage} failure releases the opening reservation and any returned handle`, async () => {
    const { service, sessions, calls, failure } = createServiceHarness();
    failure[stage] = true;
    await assert.rejects(service.openPage({ url: "https://example.com/" }), /failed/);
    assert.equal(calls.close, stage === "register" ? 1 : 0);
    assert.deepEqual(sessions.all(), []);
    failure[stage] = false;
    await service.openPage({ url: "https://example.com/retry" });
    assert.equal(calls.open, 2);
    await service.shutdown();
    assert.deepEqual(sessions.all(), []);
  });
}

test("failed registration rollback stays owned and blocks new opens until cleanup succeeds", async () => {
  const { service, sessions, calls, failure } = createServiceHarness();
  failure.register = true;
  failure.close = true;
  await assert.rejects(service.openPage({ url: "https://example.com/" }), /cleanup is pending/);
  assert.equal(sessions.pending().length, 1);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(service.openPage({ url: "https://example.com/retry" }), /cleanup is still pending/);
  }
  assert.equal(calls.open, 1);
  assert.equal(sessions.pending().length, 1);
  assert.deepEqual(calls.expired, []);
  failure.close = false;
  failure.register = false;
  await service.openPage({ url: "https://example.com/recovered" });
  assert.equal(calls.open, 2);
  await service.shutdown();
  assert.deepEqual(sessions.all(), []);
});

test("capacity eviction completes before launch and a failed eviction does not admit another page", async () => {
  const { service, sessions, calls, failure } = createServiceHarness();
  const first = await service.openPage({ url: "https://example.com/one" });
  failure.close = true;
  await assert.rejects(service.openPage({ url: "https://example.com/two" }), /close failed/);
  assert.equal(calls.open, 1);
  assert.equal(sessions.pending().length, 1);
  assert.deepEqual(calls.expired, []);
  failure.close = false;
  const second = await service.openPage({ url: "https://example.com/two" });
  assert.equal(calls.open, 2);
  assert.deepEqual(calls.expired, [first.resource_id]);
  assert.equal(sessions.values()[0]?.resourceId, second.resource_id);
  await service.shutdown();
});

test("opening reservations cap concurrent acquisition and shutdown waits for ownership transfer", async () => {
  const { service, sessions, calls, control, openingStarted } = createServiceHarness();
  const gate = deferred();
  control.openGate = gate.promise;
  const opening = service.openPage({ url: "https://example.com/one" });
  await openingStarted.promise;
  await assert.rejects(service.openPage({ url: "https://example.com/two" }), /capacity is exhausted/);
  let shutdownFinished = false;
  const shutdown = service.shutdown().then(() => { shutdownFinished = true; });
  await assert.rejects(service.openPage({ url: "https://example.com/three" }), /shutting down/);
  assert.equal(shutdownFinished, false);
  assert.equal(calls.close, 0);

  gate.resolve();
  await opening;
  await shutdown;
  await service.shutdown();
  assert.equal(calls.open, 1);
  assert.equal(calls.close, 1);
  assert.deepEqual(sessions.all(), []);
});

test("concurrent manual close and shutdown share disposal and shutdown can retry failures", async () => {
  const { service, sessions, calls, failure } = createServiceHarness();
  const opened = await service.openPage({ url: "https://example.com/" });
  failure.close = true;
  const results = await Promise.allSettled([service.closePage(opened.resource_id), service.shutdown()]);
  assert.equal(results.every((result) => result.status === "rejected"), true);
  assert.equal(calls.close, 1);
  assert.equal(sessions.pending().length, 1);
  failure.close = false;
  await service.shutdown();
  assert.equal(calls.close, 2);
  assert.deepEqual(calls.closed, [opened.resource_id]);
  assert.deepEqual(sessions.all(), []);
});

test("an interaction finishing after shutdown cannot write its snapshot or reactivate a page", async () => {
  const { service, sessions, calls } = createServiceHarness();
  const opened = await service.openPage({ url: "https://example.com/" });
  const session = sessions.get(opened.resource_id);
  assert.ok(session);
  const interacting = deferred();
  const release = deferred();
  service.deps.playwrightBackend.interact = async (input) => {
    interacting.resolve();
    await release.promise;
    return { state: input.state, snapshot: { ...input.snapshot, title: "Late result" } };
  };
  const interaction = service.interactWithPage({ resourceId: opened.resource_id, action: "wait" });
  await interacting.promise;
  assert.equal(calls.touch, 1);
  await service.shutdown();
  release.resolve();
  await assert.rejects(interaction, /closed during interaction/);
  assert.equal(session.snapshot.title, "Example");
  assert.equal(calls.touch, 1);
  assert.equal(calls.close, 1);
  assert.deepEqual(calls.expired, [opened.resource_id]);
  assert.deepEqual(sessions.all(), []);
});
