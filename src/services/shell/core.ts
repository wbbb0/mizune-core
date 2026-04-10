import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { spawn as spawnPty } from "node-pty";
import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";

const execFileAsync = promisify(execFile);

export interface SpawnedShellIo {
  pid: number | null;
  write: (data: string) => void;
  kill: (signal?: string) => void;
  onOutput: (listener: (chunk: string) => void) => void;
  onError: (listener: (error: Error) => void) => void;
  onClose: (listener: (exitCode: number | null, signal: string | null) => void) => void;
}

export function resolveAllowedShellCwd(config: AppConfig, input: string | undefined, label = "cwd"): string {
  const configuredRoot = String(config.localFiles.root ?? "").trim();
  const defaultRoot = resolve(!configuredRoot || configuredRoot === "data" ? config.dataDir : configuredRoot);
  return resolve(input?.trim() || defaultRoot);
}

export function getDefaultShell(shell?: string): string {
  return shell?.trim() || process.env.SHELL || "/bin/sh";
}

export function buildShellArgs(login: boolean, command?: string): string[] {
  if (command == null) {
    return login ? ["-l"] : [];
  }
  return login ? ["-lc", command] : ["-c", command];
}

export function trimOutputTail(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }
  return input.slice(input.length - maxChars);
}

export function waitForShellYield(ms: number): Promise<void> {
  return new Promise((resolveWait) => {
    setTimeout(resolveWait, Math.max(0, Math.round(ms)));
  });
}

export async function resolveShellForegroundCommand(pid: number | null): Promise<string | null> {
  if (!Number.isInteger(pid) || Number(pid) <= 0) {
    return null;
  }

  const { stdout } = await execFileAsync("ps", ["-ax", "-o", "pid=,ppid=,args="], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });
  const processTable = parseProcessTable(String(stdout ?? ""));
  if (processTable.length === 0) {
    return null;
  }

  const descendants = collectDescendants(processTable, Number(pid));
  if (descendants.length === 0) {
    return null;
  }

  const candidate = descendants
    .sort((left, right) => {
      if (right.depth !== left.depth) {
        return right.depth - left.depth;
      }
      return right.pid - left.pid;
    })[0];

  return candidate ? normalizeProcessCommand(candidate.args) : null;
}

export function spawnShellIo(params: {
  shell: string;
  args: string[];
  cwd: string;
  preferPty: boolean;
  logger: Logger;
  fallbackLogEvent: string;
  fallbackLogFields?: Record<string, unknown>;
}): {
  io: SpawnedShellIo;
  ttyGranted: boolean;
  ptyFallbackError: unknown | null;
} {
  if (params.preferPty) {
    try {
      return {
        io: createPtyIo(params.shell, params.args, params.cwd),
        ttyGranted: true,
        ptyFallbackError: null
      };
    } catch (error: unknown) {
      params.logger.warn({ ...params.fallbackLogFields, error }, params.fallbackLogEvent);
      return {
        io: createPipeIo(params.shell, params.args, params.cwd),
        ttyGranted: false,
        ptyFallbackError: error
      };
    }
  }

  return {
    io: createPipeIo(params.shell, params.args, params.cwd),
    ttyGranted: false,
    ptyFallbackError: null
  };
}

function createPipeIo(shell: string, args: string[], cwd: string): SpawnedShellIo {
  const child = spawn(shell, args, {
    cwd,
    env: process.env,
    stdio: "pipe"
  });
  return {
    pid: child.pid ?? null,
    write: (data) => {
      child.stdin.write(data);
    },
    kill: (signal) => {
      child.kill(signal as NodeJS.Signals | undefined);
    },
    onOutput: (listener) => {
      child.stdout.on("data", (chunk: Buffer) => {
        listener(chunk.toString("utf8"));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        listener(chunk.toString("utf8"));
      });
    },
    onError: (listener) => {
      child.on("error", listener);
    },
    onClose: (listener) => {
      child.on("close", (exitCode, signal) => {
        listener(exitCode, signal ?? null);
      });
    }
  };
}

function createPtyIo(shell: string, args: string[], cwd: string): SpawnedShellIo {
  const pty = spawnPty(shell, args, {
    cwd,
    env: process.env,
    cols: 120,
    rows: 30,
    name: "xterm-256color"
  });
  return {
    pid: pty.pid,
    write: (data) => {
      pty.write(data);
    },
    kill: (signal) => {
      pty.kill(signal);
    },
    onOutput: (listener) => {
      pty.onData(listener);
    },
    onError: (_listener) => {},
    onClose: (listener) => {
      pty.onExit(({ exitCode, signal }) => {
        listener(exitCode, signal != null ? String(signal) : null);
      });
    }
  };
}

function parseProcessTable(stdout: string): Array<{ pid: number; ppid: number; args: string }> {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) {
        return [];
      }
      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      const args = String(match[3] ?? "").trim();
      if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !args) {
        return [];
      }
      return [{ pid, ppid, args }];
    });
}

function collectDescendants(
  processTable: Array<{ pid: number; ppid: number; args: string }>,
  rootPid: number
): Array<{ pid: number; ppid: number; args: string; depth: number }> {
  const byParent = new Map<number, Array<{ pid: number; ppid: number; args: string }>>();
  for (const item of processTable) {
    const siblings = byParent.get(item.ppid) ?? [];
    siblings.push(item);
    byParent.set(item.ppid, siblings);
  }

  const descendants: Array<{ pid: number; ppid: number; args: string; depth: number }> = [];
  const queue = (byParent.get(rootPid) ?? []).map((item) => ({ ...item, depth: 1 }));
  while (queue.length > 0) {
    const current = queue.shift()!;
    descendants.push(current);
    for (const child of byParent.get(current.pid) ?? []) {
      queue.push({ ...child, depth: current.depth + 1 });
    }
  }
  return descendants;
}

function normalizeProcessCommand(args: string): string | null {
  const normalized = String(args ?? "").trim().replace(/\s+/g, " ");
  return normalized || null;
}
