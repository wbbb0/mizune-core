import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ShellRuntime } from "../../src/services/shell/runtime.ts";
import { createForwardFeatureConfig, runCase } from "../helpers/forward-test-support.tsx";
import { createSilentLogger } from "../helpers/browser-test-support.tsx";

async function main() {
  await runCase("shell runtime title tracks the live foreground command", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-shell-runtime-title-"));
    const config = createForwardFeatureConfig();
    config.shell.enabled = true;
    config.shell.mode = "full";
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
      await new Promise((resolve) => setTimeout(resolve, 150));
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
