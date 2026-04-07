import { spawn } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const isWindows = process.platform === "win32";

const childSpecs = [
  {
    name: "bot",
    command: npmCommand,
    args: ["run", "dev:bot"]
  },
  {
    name: "webui",
    command: npmCommand,
    args: ["run", "dev:webui"]
  }
];

const children = new Set();
let shuttingDown = false;
let forcedExitTimer = null;

function terminateChildProcessGroup(child, signal) {
  if (child.exitCode != null || child.signalCode != null) {
    return;
  }

  if (isWindows) {
    child.kill(signal);
    return;
  }

  if (typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code !== "ESRCH") {
        console.error("[dev] failed to signal child process group:", error);
      }
    }
  }

  child.kill(signal);
}

function stopChildren(signal = "SIGTERM") {
  if (children.size === 0) {
    return;
  }

  for (const child of children) {
    terminateChildProcessGroup(child, signal);
  }

  if (signal === "SIGTERM" && forcedExitTimer == null) {
    forcedExitTimer = setTimeout(() => {
      stopChildren("SIGKILL");
    }, 5_000);
    forcedExitTimer.unref();
  }
}

function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  process.exitCode = exitCode;
  stopChildren();
}

for (const spec of childSpecs) {
  const child = spawn(spec.command, spec.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    detached: !isWindows
  });

  children.add(child);

  child.on("exit", (code, signal) => {
    children.delete(child);

    if (children.size === 0) {
      if (forcedExitTimer != null) {
        clearTimeout(forcedExitTimer);
      }
      process.exit(code ?? (signal == null ? 0 : 1));
    }

    if (!shuttingDown) {
      const exitCode = code ?? 1;
      console.error(`[dev] ${spec.name} exited unexpectedly${signal ? ` (${signal})` : ""}`);
      shutdown(exitCode);
    }
  });

  child.on("error", (error) => {
    console.error(`[dev] failed to start ${spec.name}:`, error);
    shutdown(1);
  });
}

process.on("SIGINT", () => {
  shutdown(130);
});

process.on("SIGTERM", () => {
  shutdown(143);
});
