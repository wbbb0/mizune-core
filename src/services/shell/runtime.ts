import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { RuntimeResourceRegistry } from "#runtime/resources/runtimeResourceRegistry.ts";
import type { ShellSessionResourceSummary } from "./types.ts";
import {
  buildShellArgs,
  getDefaultShell,
  resolveShellForegroundCommand,
  resolveAllowedShellCwd,
  spawnShellIo,
  trimOutputTail,
  waitForShellYield
} from "./core.ts";
import type { ShellRunParams, ShellRunResult, ShellSession } from "./types.ts";

interface InternalSessionState {
  view: ShellSession;
  pendingOutput: string;
  write: (data: string) => void;
  kill: (signal?: string) => void;
  expiresAtMs: number | null;
}

function isClosedSession(session: ShellSession): boolean {
  return session.status === "closed";
}

export class ShellRuntime {
  private readonly sessions = new Map<string, InternalSessionState>();
  private readonly resourceRegistry: RuntimeResourceRegistry;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    dataDir: string
  ) {
    this.resourceRegistry = new RuntimeResourceRegistry(dataDir, logger);
  }

  isEnabled(): boolean {
    return this.config.shell.enabled;
  }

  async run(params: ShellRunParams): Promise<ShellRunResult> {
    if (!this.isEnabled()) {
      throw new Error("Shell runtime is disabled");
    }

    const command = params.command.trim();
    if (!command) {
      throw new Error("command is required");
    }

    await this.cleanupExpiredSessions();

    const cwd = resolveAllowedShellCwd(this.config, params.cwd);
    const shell = getDefaultShell(params.shell);
    const login = params.login ?? true;
    const tty = params.tty ?? true;
    const background = params.background ?? false;
    const timeoutMs = params.timeoutMs ?? this.config.shell.defaultTimeoutMs;
    const now = Date.now();

    const spawned = spawnShellIo({
      shell,
      args: buildShellArgs(login, command),
      cwd,
      preferPty: tty,
      logger: this.logger,
      fallbackLogEvent: "shell_run_pty_failed_fallback_to_pipe",
      fallbackLogFields: { command, cwd }
    });

    const resource = await this.resourceRegistry.createShellSession({
      title: summarizeShellTitle(command, cwd),
      description: normalizeOptionalDescription(params.description),
      summary: summarizeShellSummary(command, cwd),
      createdAtMs: now,
      expiresAtMs: this.computeNextExpiry(),
      shellSession: {
        command,
        cwd,
        shell,
        tty: spawned.ttyGranted,
        login
      }
    });

    const view: ShellSession = {
      id: resource.resourceId,
      command,
      cwd,
      shell,
      login,
      tty: spawned.ttyGranted,
      createdAtMs: now,
      updatedAtMs: now,
      status: "running",
      pid: spawned.io.pid,
      exitCode: null,
      signal: null,
      outputTail: "",
      error: spawned.ptyFallbackError ? String(spawned.ptyFallbackError) : null
    };

    const state: InternalSessionState = {
      view,
      pendingOutput: "",
      write: spawned.io.write,
      kill: spawned.io.kill,
      expiresAtMs: this.computeNextExpiry()
    };

    this.sessions.set(resource.resourceId, state);

    spawned.io.onOutput((chunk) => {
      state.pendingOutput += chunk;
      state.view.outputTail = trimOutputTail(state.view.outputTail + chunk, this.config.shell.maxOutputChars);
      state.view.updatedAtMs = Date.now();
    });

    spawned.io.onError((error) => {
      state.view.error = error.message;
      this.logger.error({ error, resourceId: resource.resourceId }, "shell_session_error");
    });

    spawned.io.onClose((exitCode, signal) => {
      state.view.status = "closed";
      state.view.exitCode = exitCode;
      state.view.signal = signal;
      state.view.pid = null;
      state.view.updatedAtMs = Date.now();
      void this.resourceRegistry.touch(resource.resourceId, {
        accessedAtMs: state.view.updatedAtMs,
        summary: summarizeClosedShellSummary(state.view),
        status: "closed"
      });
    });

    if (!background) {
      const startWait = Date.now();
      while (state.view.status === "running" && Date.now() - startWait < timeoutMs) {
        await waitForShellYield(100);
      }
    }

    const output = state.pendingOutput;
    state.pendingOutput = "";

    if (isClosedSession(state.view)) {
      const result: ShellRunResult = {
        output,
        status: "completed",
        exitCode: state.view.exitCode,
        signal: state.view.signal
      };
      this.sessions.delete(resource.resourceId);
      return result;
    }

    await this.touchSession(resource.resourceId, state);
    return {
      output,
      resourceId: resource.resourceId,
      status: "running"
    };
  }

  async interact(resourceId: string, input: string): Promise<{ output: string; session: ShellSession }> {
    await this.cleanupExpiredSessions();
    const state = await this.requireState(resourceId);
    if (state.view.status !== "running") {
      throw new Error(`Session ${resourceId} is already closed`);
    }

    state.write(input);
    await waitForShellYield(500);

    const output = state.pendingOutput;
    state.pendingOutput = "";

    if (isClosedSession(state.view)) {
      this.sessions.delete(resourceId);
    } else {
      await this.touchSession(resourceId, state);
    }

    return { output, session: state.view };
  }

  async read(resourceId: string): Promise<{ output: string; session: ShellSession }> {
    await this.cleanupExpiredSessions();
    const state = await this.requireState(resourceId);

    const output = state.pendingOutput;
    state.pendingOutput = "";

    if (isClosedSession(state.view)) {
      this.sessions.delete(resourceId);
    } else {
      await this.touchSession(resourceId, state);
    }

    return { output, session: state.view };
  }

  async signal(resourceId: string, signal: string): Promise<ShellSession> {
    await this.cleanupExpiredSessions();
    const state = await this.requireState(resourceId);

    state.kill(signal);
    await waitForShellYield(100);
    await this.touchSession(resourceId, state);
    return state.view;
  }

  listSessions(): ShellSession[] {
    return Array.from(this.sessions.values()).map((item) => item.view);
  }

  async listSessionResources(): Promise<ShellSessionResourceSummary[]> {
    await this.cleanupExpiredSessions();
    const records = await this.resourceRegistry.list("shell_session");
    const sessions: ShellSessionResourceSummary[] = [];

    for (const record of records) {
      if (!record.shellSession) {
        continue;
      }
      const activeState = this.sessions.get(record.resourceId);
      const resolvedStatus = activeState ? "active" : (record.status === "active" ? "expired" : record.status);
      if (!activeState && record.status === "active") {
        await this.resourceRegistry.markStatus(record.resourceId, "expired", Date.now());
      }
      if (!activeState || resolvedStatus !== "active") {
        continue;
      }
      const title = await this.resolveSessionTitle(activeState, record.resourceId);
      sessions.push({
        resource_id: record.resourceId,
        status: resolvedStatus,
        command: record.shellSession.command,
        cwd: record.shellSession.cwd,
        shell: record.shellSession.shell,
        tty: record.shellSession.tty,
        login: record.shellSession.login,
        title,
        description: record.description,
        summary: record.summary,
        createdAtMs: record.createdAtMs,
        lastAccessedAtMs: record.lastAccessedAtMs,
        expiresAtMs: activeState.expiresAtMs
      });
    }

    return sessions;
  }

  closeSession(resourceId: string): void {
    const state = this.sessions.get(resourceId);
    if (state) {
      state.kill("SIGKILL");
      this.sessions.delete(resourceId);
      void this.resourceRegistry.markStatus(resourceId, "closed", Date.now());
    }
  }

  private async requireState(resourceId: string): Promise<InternalSessionState> {
    const state = this.sessions.get(resourceId);
    if (!state) {
      await this.resourceRegistry.markStatus(resourceId, "expired", Date.now()).catch(() => null);
      throw new Error(`Session ${resourceId} not found`);
    }
    return state;
  }

  private computeNextExpiry(): number | null {
    return this.config.shell.sessionTtlMs == null
      ? null
      : Date.now() + this.config.shell.sessionTtlMs;
  }

  private async touchSession(resourceId: string, state: InternalSessionState): Promise<void> {
    state.expiresAtMs = this.computeNextExpiry();
    state.view.updatedAtMs = Date.now();
    const title = await this.resolveSessionTitle(state, resourceId);
    await this.resourceRegistry.touch(resourceId, {
      accessedAtMs: state.view.updatedAtMs,
      expiresAtMs: state.expiresAtMs,
      title,
      summary: summarizeShellSummary(state.view.command, state.view.cwd),
      status: state.view.status === "running" ? "active" : "closed"
    });
  }

  private async cleanupExpiredSessions(): Promise<void> {
    const now = Date.now();
    const expired = Array.from(this.sessions.entries()).filter(([, state]) => (
      state.expiresAtMs != null && state.expiresAtMs <= now
    ));
    if (expired.length === 0) {
      return;
    }

    for (const [resourceId, state] of expired) {
      state.kill("SIGKILL");
      this.sessions.delete(resourceId);
      await this.resourceRegistry.markStatus(resourceId, "expired", now).catch(() => null);
    }

    this.logger.info({ expiredSessionCount: expired.length }, "shell_sessions_expired");
  }

  private async resolveSessionTitle(state: InternalSessionState, resourceId: string): Promise<string> {
    const liveCommand = await resolveShellForegroundCommand(state.view.pid).catch((error: unknown) => {
      this.logger.debug(
        { error: error instanceof Error ? error.message : String(error), resourceId, pid: state.view.pid },
        "shell_foreground_command_resolve_failed"
      );
      return null;
    });
    return liveCommand
      ? summarizeShellLiveTitle(liveCommand)
      : summarizeShellTitle(state.view.command, state.view.cwd);
  }
}

function summarizeShellTitle(command: string, cwd: string): string {
  return `${command.slice(0, 48)} @ ${cwd}`;
}

function summarizeShellLiveTitle(command: string): string {
  return command.slice(0, 72);
}

function summarizeShellSummary(command: string, cwd: string): string {
  return `${command.slice(0, 120)} (cwd=${cwd})`;
}

function summarizeClosedShellSummary(session: ShellSession): string {
  const status = session.exitCode != null
    ? `exit=${session.exitCode}`
    : (session.signal ? `signal=${session.signal}` : "closed");
  return `${session.command.slice(0, 120)} (${status})`;
}

function normalizeOptionalDescription(value: string | undefined): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}
