import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShellRuntime } from "../../src/services/shell/runtime.ts";
import type { ShellRuntimeEvent } from "../../src/services/shell/types.ts";
import { createSilentLogger } from "../helpers/browser-test-support.tsx";
import { createForwardFeatureConfig } from "../helpers/forward-test-support.tsx";

const owner = {
  sessionId: "private:test:user",
  userId: "user",
  senderName: "User"
};

describe("shell runtime terminal events", () => {
  test("emits close event only after terminal_run has returned a background resource", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-shell-events-"));
    const config = createForwardFeatureConfig();
    config.shell.enabled = true;
    config.shell.terminalEvents.inputDetectionDebounceMs = 5;
    config.shell.terminalEvents.inputConfirmationMs = 5;
    const events: ShellRuntimeEvent[] = [];
    const runtime = new ShellRuntime(config, createSilentLogger(), dataDir, {
      onEvent: (event) => {
        events.push(event);
      }
    });

    try {
      const result = await runtime.run({
        command: "node -e \"setTimeout(() => console.log('done'), 300)\"",
        cwd: "/tmp",
        tty: false,
        login: false,
        timeoutMs: 10,
        owner
      });
      assert.equal(result.status, "running");

      const event = await waitForEvent(events, "session_closed");
      assert.equal(event.owner.sessionId, owner.sessionId);
      assert.equal(event.exitCode, 0);
      assert.match(event.output, /done/);
    } finally {
      await settleAsyncResourceWrites();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("does not emit close event for terminal_run completed in the foreground", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-shell-events-"));
    const config = createForwardFeatureConfig();
    config.shell.enabled = true;
    const events: ShellRuntimeEvent[] = [];
    const runtime = new ShellRuntime(config, createSilentLogger(), dataDir, {
      onEvent: (event) => {
        events.push(event);
      }
    });

    try {
      const result = await runtime.run({
        command: "node -e \"console.log('done')\"",
        cwd: "/tmp",
        tty: false,
        login: false,
        timeoutMs: 2000,
        owner
      });
      assert.equal(result.status, "completed");
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.deepEqual(events, []);
    } finally {
      await settleAsyncResourceWrites();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("emits debounced input-required event once for stable prompts", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-shell-events-"));
    const config = createForwardFeatureConfig();
    config.shell.enabled = true;
    config.shell.terminalEvents.inputDetectionDebounceMs = 5;
    config.shell.terminalEvents.inputConfirmationMs = 10;
    config.shell.terminalEvents.inputPromptCooldownMs = 5000;
    const events: ShellRuntimeEvent[] = [];
    const runtime = new ShellRuntime(config, createSilentLogger(), dataDir, {
      onEvent: (event) => {
        events.push(event);
      }
    });

    try {
      const result = await runtime.run({
        command: "node -e \"process.stdout.write('Proceed? [y/N] '); setTimeout(() => {}, 500)\"",
        cwd: "/tmp",
        tty: false,
        login: false,
        timeoutMs: 10,
        owner
      });
      assert.equal(result.status, "running");

      const event = await waitForEvent(events, "input_required");
      assert.equal(event.promptKind, "confirmation");
      assert.match(event.promptText, /Proceed/);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(events.filter((item) => item.kind === "input_required").length, 1);
      runtime.closeSession(String(result.resourceId));
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      await settleAsyncResourceWrites();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("suppresses duplicate prompt detection after terminal input", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-shell-events-"));
    const config = createForwardFeatureConfig();
    config.shell.enabled = true;
    config.shell.terminalEvents.inputDetectionDebounceMs = 5;
    config.shell.terminalEvents.inputConfirmationMs = 10;
    config.shell.terminalEvents.inputSuppressionAfterWriteMs = 80;
    const events: ShellRuntimeEvent[] = [];
    const runtime = new ShellRuntime(config, createSilentLogger(), dataDir, {
      onEvent: (event) => {
        events.push(event);
      }
    });

    try {
      const result = await runtime.run({
        command: "node -e \"process.stdout.write('Proceed? [y/N] '); process.stdin.on('data', () => process.stdout.write('Proceed? [y/N] ')); setTimeout(() => {}, 500)\"",
        cwd: "/tmp",
        tty: false,
        login: false,
        timeoutMs: 10,
        owner
      });
      assert.equal(result.status, "running");
      await waitForEvent(events, "input_required");
      await runtime.interact(String(result.resourceId), "n\n");
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(events.filter((item) => item.kind === "input_required").length, 1);
      runtime.closeSession(String(result.resourceId));
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      await settleAsyncResourceWrites();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

async function waitForEvent<K extends ShellRuntimeEvent["kind"]>(
  events: ShellRuntimeEvent[],
  kind: K
): Promise<Extract<ShellRuntimeEvent, { kind: K }>> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const event = events.find((item): item is Extract<ShellRuntimeEvent, { kind: K }> => item.kind === kind);
    if (event) {
      return event;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for shell event ${kind}`);
}

async function settleAsyncResourceWrites(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
