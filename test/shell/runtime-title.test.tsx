import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ShellRuntime } from "../../src/services/shell/runtime.ts";
import { createForwardFeatureConfig } from "../helpers/forward-test-support.tsx";
import { createSilentLogger } from "../helpers/browser-test-support.tsx";
import { createRuntimeResourceHarness, waitForRuntimeResourceStatus } from "../helpers/runtime-resource-test-support.ts";

function createShellRuntimeForDir(dataDir: string, config: ReturnType<typeof createForwardFeatureConfig>) {
  const logger = createSilentLogger();
  const harness = createRuntimeResourceHarness(dataDir, logger);
  return {
    runtime: new ShellRuntime(config, logger, harness.runtimeResourceRegistry),
    runtimeResourceStore: harness.runtimeResourceStore
  };
}

  test("shell runtime title tracks the live foreground command", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-shell-runtime-title-"));
    const config = createForwardFeatureConfig();
    config.shell.enabled = true;
    const { runtime, runtimeResourceStore } = createShellRuntimeForDir(dataDir, config);

    try {
      const result = await runtime.run({
        command: "echo ready && sleep 5",
        cwd: "/tmp",
        tty: false,
        timeoutMs: 50
      });

      assert.equal(result.status, "running");
      assert.ok(result.resourceId);

      const resources = await runtime.listSessionResources();
      assert.equal(resources.length, 1);
      assert.match(String(resources[0]?.title ?? ""), /sleep 5/);

      runtime.closeSession(String(result.resourceId));
      await waitForRuntimeResourceStatus({
        store: runtimeResourceStore,
        resourceId: String(result.resourceId),
        status: "closed"
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
