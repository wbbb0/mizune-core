import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ShellRuntime } from "../../src/services/shell/runtime.ts";
import { createForwardFeatureConfig } from "../helpers/forward-test-support.tsx";
import { createSilentLogger } from "../helpers/browser-test-support.tsx";

async function waitForClosedResourceRecord(dataDir: string, resourceId: string): Promise<void> {
  const deadline = Date.now() + 300;
  while (Date.now() < deadline) {
    try {
      const raw = await readFile(join(dataDir, "live-resources.json"), "utf8");
      const parsed = JSON.parse(raw) as { resources?: Array<{ resourceId?: string; status?: string }> };
      const record = parsed.resources?.find((item) => item.resourceId === resourceId);
      if (record?.status === "closed") {
        return;
      }
    } catch {
      // Ignore partial writes while closeSession's async persistence is still in flight.
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for closed shell resource ${resourceId}`);
}

  test("shell runtime title tracks the live foreground command", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-shell-runtime-title-"));
    const config = createForwardFeatureConfig();
    config.shell.enabled = true;
    const runtime = new ShellRuntime(config, createSilentLogger(), dataDir);

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
      await waitForClosedResourceRecord(dataDir, String(result.resourceId));
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
