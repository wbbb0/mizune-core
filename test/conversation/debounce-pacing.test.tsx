import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { DebounceManager } from "../../src/conversation/debounceManager.ts";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

function createHarness(source: "onebot" | "web") {
  const config = createTestAppConfig({
    conversation: {
      debounce: {
        defaultBaseSeconds: 0.02,
        minBaseSeconds: 0.02,
        maxBaseSeconds: 0.02,
        smoothingFactor: 1,
        finalMultiplier: 1,
        plannerWaitMultiplier: 1,
        randomRatioMin: 1,
        randomRatioMax: 1
      }
    }
  });
  const sessionManager = new SessionManager(config);
  const sessionId = source === "web" ? "web:pacing" : "qqbot:p:pacing";
  sessionManager.ensureSession({ id: sessionId, type: "private", source });
  return {
    sessionId,
    sessionManager,
    debounceManager: new DebounceManager(pino({ level: "silent" }), sessionManager, config)
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("session pacing defaults follow the session source", () => {
  const web = createHarness("web");
  const oneBot = createHarness("onebot");

  assert.deepEqual(web.sessionManager.getPacingPreferences(web.sessionId), {
    inputDebounce: { mode: "immediate" },
    oneBotOutbound: "immediate"
  });
  assert.deepEqual(oneBot.sessionManager.getPacingPreferences(oneBot.sessionId), {
    inputDebounce: { mode: "adaptive" },
    oneBotOutbound: "humanized"
  });
});

test("web input debounce fires immediately by default", async () => {
  const harness = createHarness("web");
  let fired = false;
  harness.debounceManager.schedule(harness.sessionId, () => {
    fired = true;
  });

  await wait(5);
  assert.equal(fired, true);
});

test("fixed session debounce overrides normal input scheduling", async () => {
  const harness = createHarness("web");
  harness.sessionManager.setSettings(harness.sessionId, {
    pacingPreferences: {
      inputDebounce: { mode: "fixed", delayMs: 25 },
      oneBotOutbound: "immediate"
    },
    toolsetPreferences: harness.sessionManager.getToolsetPreferences(harness.sessionId)
  });
  let fired = false;
  harness.debounceManager.schedule(harness.sessionId, () => {
    fired = true;
  });

  await wait(5);
  assert.equal(fired, false);
  await wait(35);
  assert.equal(fired, true);
});

test("turn planner gate waits ignore the immediate input preference", async () => {
  const harness = createHarness("web");
  let fired = false;
  harness.debounceManager.schedule(harness.sessionId, () => {
    fired = true;
  }, { reason: "gate_wait", multiplierOverride: 1 });

  await wait(5);
  assert.equal(fired, false);
  await wait(30);
  assert.equal(fired, true);
});
