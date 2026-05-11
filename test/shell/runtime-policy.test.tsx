import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShellRuntime } from "../../src/services/shell/runtime.ts";
import { createSilentLogger } from "../helpers/browser-test-support.tsx";
import { createForwardFeatureConfig } from "../helpers/forward-test-support.tsx";
import { createRuntimeResourceHarness } from "../helpers/runtime-resource-test-support.ts";

function createShellRuntimeForDir(config: ReturnType<typeof createForwardFeatureConfig>, dataDir: string): ShellRuntime {
  const logger = createSilentLogger();
  const { runtimeResourceRegistry } = createRuntimeResourceHarness(dataDir, logger);
  return new ShellRuntime(config, logger, runtimeResourceRegistry);
}

describe("shell runtime policy", () => {
  test("clamps foreground timeout to shell.maxTimeoutMs", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-shell-policy-"));
    const config = createForwardFeatureConfig();
    config.shell.maxTimeoutMs = 20;
    const runtime = createShellRuntimeForDir(config, dataDir);
    try {
      const result = await runtime.run({
        command: "node -e \"setTimeout(() => {}, 1000)\"",
        cwd: "/tmp",
        tty: false,
        login: false,
        timeoutMs: 10_000
      });

      assert.equal(result.status, "running");
      assert.equal(result.effectiveTimeoutMs, 20);
      assert.equal(result.effective_timeout_ms, 20);
      runtime.closeSession(String(result.resourceId));
      await settleAsyncResourceWrites();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("rejects cwd outside configured shell roots", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-shell-policy-"));
    const config = createForwardFeatureConfig();
    config.shell.cwd.allowedRoots = ["/tmp"];
    const runtime = createShellRuntimeForDir(config, dataDir);
    try {
      await assert.rejects(
        () => runtime.run({
          command: "pwd",
          cwd: "/",
          tty: false,
          login: false
        }),
        /shell cwd is outside allowed roots/
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("returns structured rejection for denied commands", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-shell-policy-"));
    const config = createForwardFeatureConfig();
    const runtime = createShellRuntimeForDir(config, dataDir);
    try {
      const result = await runtime.run({
        command: "vim README.md",
        cwd: "/tmp",
        tty: false,
        login: false
      });

      assert.equal(result.status, "rejected");
      assert.equal(result.policy?.decision, "deny");
      assert.match(String(result.policy?.reason), /standalone policy/);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("rejects denied commands after shell separators", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-shell-policy-"));
    const config = createForwardFeatureConfig();
    const runtime = createShellRuntimeForDir(config, dataDir);
    try {
      const result = await runtime.run({
        command: "echo ok && vim README.md",
        cwd: "/tmp",
        tty: false,
        login: false
      });

      assert.equal(result.status, "rejected");
      assert.equal(result.policy?.decision, "deny");
      assert.match(String(result.policy?.reason), /vim/);

      const newlineResult = await runtime.run({
        command: "echo ok\nvim README.md",
        cwd: "/tmp",
        tty: false,
        login: false
      });
      assert.equal(newlineResult.status, "rejected");
      assert.match(String(newlineResult.policy?.reason), /vim/);

      const backgroundResult = await runtime.run({
        command: "echo ok & vim README.md",
        cwd: "/tmp",
        tty: false,
        login: false
      });
      assert.equal(backgroundResult.status, "rejected");
      assert.match(String(backgroundResult.policy?.reason), /vim/);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("does not treat separators inside quoted arguments as command separators", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-shell-policy-"));
    const config = createForwardFeatureConfig();
    const runtime = createShellRuntimeForDir(config, dataDir);
    try {
      const result = await runtime.run({
        command: "printf 'vim README.md && ok'",
        cwd: "/tmp",
        tty: false,
        login: false
      });

      assert.notEqual(result.status, "rejected");
      assert.equal(result.policy?.decision, "allow");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("rejects denied prefixes after shell separators", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-shell-policy-"));
    const config = createForwardFeatureConfig();
    const runtime = createShellRuntimeForDir(config, dataDir);
    try {
      const result = await runtime.run({
        command: "cd /tmp; rm -rf /",
        cwd: "/tmp",
        tty: false,
        login: false
      });

      assert.equal(result.status, "rejected");
      assert.equal(result.policy?.decision, "deny");
      assert.match(String(result.policy?.reason), /rm -rf/);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("rejects denied commands behind common shell wrappers", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-shell-policy-"));
    const config = createForwardFeatureConfig();
    const runtime = createShellRuntimeForDir(config, dataDir);
    try {
      const sudoResult = await runtime.run({
        command: "sudo -E vim README.md",
        cwd: "/tmp",
        tty: false,
        login: false
      });
      assert.equal(sudoResult.status, "rejected");
      assert.match(String(sudoResult.policy?.reason), /vim/);

      const sudoUserResult = await runtime.run({
        command: "sudo -u root rm -rf /",
        cwd: "/tmp",
        tty: false,
        login: false
      });
      assert.equal(sudoUserResult.status, "rejected");
      assert.match(String(sudoUserResult.policy?.reason), /rm -rf/);

      const envResult = await runtime.run({
        command: "env FOO=bar rm -rf /",
        cwd: "/tmp",
        tty: false,
        login: false
      });
      assert.equal(envResult.status, "rejected");
      assert.match(String(envResult.policy?.reason), /rm -rf/);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("returns running foreground command after output becomes idle", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-shell-policy-"));
    const config = createForwardFeatureConfig();
    config.shell.idleTimeoutMs = 30;
    const runtime = createShellRuntimeForDir(config, dataDir);
    try {
      const startedAt = Date.now();
      const result = await runtime.run({
        command: "node -e \"console.log('ready'); setTimeout(() => {}, 1000)\"",
        cwd: "/tmp",
        tty: false,
        login: false,
        timeoutMs: 5000
      });

      assert.equal(result.status, "running");
      assert.match(result.output, /ready/);
      assert.ok(Date.now() - startedAt < 1000);
      runtime.closeSession(String(result.resourceId));
      await settleAsyncResourceWrites();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("normalizes invalid foreground timeout to a positive wait", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-shell-policy-"));
    const config = createForwardFeatureConfig();
    const runtime = createShellRuntimeForDir(config, dataDir);
    try {
      const result = await runtime.run({
        command: "node -e \"setTimeout(() => {}, 1000)\"",
        cwd: "/tmp",
        tty: false,
        login: false,
        timeoutMs: -100
      });

      assert.equal(result.status, "running");
      assert.equal(result.effectiveTimeoutMs, 1);
      runtime.closeSession(String(result.resourceId));
      await settleAsyncResourceWrites();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("reports output truncation from bounded buffers", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-shell-policy-"));
    const config = createForwardFeatureConfig();
    config.shell.maxOutputChars = 32;
    const runtime = createShellRuntimeForDir(config, dataDir);
    try {
      const result = await runtime.run({
        command: "node -e \"console.log('x'.repeat(200))\"",
        cwd: "/tmp",
        tty: false,
        login: false,
        timeoutMs: 2000
      });

      assert.equal(result.status, "completed");
      assert.equal(result.outputTruncated, true);
      assert.match(result.output, /输出过长/);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

async function settleAsyncResourceWrites(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}
