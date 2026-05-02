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
import { detectTerminalInputPrompt, normalizeTerminalOutput } from "./inputPromptDetector.ts";
import type {
  ShellNotifyPolicy,
  ShellRunOwner,
  ShellRunParams,
  ShellRunResult,
  ShellRuntimeEvent,
  ShellRuntimeEventHandler,
  ShellSession
} from "./types.ts";

interface InternalSessionState {
  view: ShellSession;
  pendingOutput: string;
  pendingOutputTruncated: boolean;
  write: (data: string) => void;
  kill: (signal?: string) => void;
  expiresAtMs: number | null;
  owner: ShellRunOwner | null;
  notifyPolicy: ShellNotifyPolicy;
  returnedToModel: boolean;
  inputDetectionTimer: ReturnType<typeof setTimeout> | null;
  inputConfirmationTimer: ReturnType<typeof setTimeout> | null;
  inputCandidateSignature: string | null;
  lastInputPromptSignature: string | null;
  lastInputPromptNotifiedAtMs: number | null;
  inputDetectionSuppressedUntilMs: number;
  closeEventSuppressed: boolean;
}

function isClosedSession(session: ShellSession): boolean {
  return session.status === "closed";
}

export class ShellRuntime {
  private readonly sessions = new Map<string, InternalSessionState>();
  private readonly resourceRegistry: RuntimeResourceRegistry;
  private eventHandler: ShellRuntimeEventHandler | null;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    dataDir: string,
    options?: { onEvent?: ShellRuntimeEventHandler }
  ) {
    this.resourceRegistry = new RuntimeResourceRegistry(dataDir, logger);
    this.eventHandler = options?.onEvent ?? null;
  }

  isEnabled(): boolean {
    return this.config.shell.enabled;
  }

  setEventHandler(handler: ShellRuntimeEventHandler | null): void {
    this.eventHandler = handler;
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
    const notifyPolicy = params.notifyPolicy ?? (params.owner ? "notify_on_input_and_close" : "none");
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
      error: spawned.ptyFallbackError ? String(spawned.ptyFallbackError) : null,
      ownerSessionId: params.owner?.sessionId ?? null,
      ownerUserId: params.owner?.userId ?? null,
      ownerSenderName: params.owner?.senderName ?? null,
      notifyPolicy,
      lastOutputAtMs: null,
      lastInputAtMs: null,
      lastInputPromptKind: null,
      lastInputPromptAtMs: null
    };

    const state: InternalSessionState = {
      view,
      pendingOutput: "",
      pendingOutputTruncated: false,
      write: spawned.io.write,
      kill: spawned.io.kill,
      expiresAtMs: this.computeNextExpiry(),
      owner: params.owner ?? null,
      notifyPolicy,
      returnedToModel: background,
      inputDetectionTimer: null,
      inputConfirmationTimer: null,
      inputCandidateSignature: null,
      lastInputPromptSignature: null,
      lastInputPromptNotifiedAtMs: null,
      inputDetectionSuppressedUntilMs: 0,
      closeEventSuppressed: false
    };

    this.sessions.set(resource.resourceId, state);

    spawned.io.onOutput((chunk) => {
      const maxChars = this.config.shell.maxOutputChars;
      // 在入口处截断 chunk，防止后续任何缓冲区临时膨胀
      const safeChunk = chunk.length > maxChars ? trimOutputTail(chunk, maxChars) : chunk;

      const newPending = state.pendingOutput + safeChunk;
      if (newPending.length > maxChars) {
        state.pendingOutput = trimOutputTail(newPending, maxChars);
        state.pendingOutputTruncated = true;
      } else {
        state.pendingOutput = newPending;
      }

      const newTail = state.view.outputTail + safeChunk;
      state.view.outputTail = newTail.length > maxChars ? trimOutputTail(newTail, maxChars) : newTail;
      state.view.updatedAtMs = Date.now();
      state.view.lastOutputAtMs = state.view.updatedAtMs;
      this.scheduleInputDetection(resource.resourceId, state);
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
      this.cancelInputDetection(state);
      if (!state.closeEventSuppressed) {
        void this.resourceRegistry.touch(resource.resourceId, {
          accessedAtMs: state.view.updatedAtMs,
          summary: summarizeClosedShellSummary(state.view),
          status: "closed"
        });
      }
      this.emitClosedEventIfNeeded(resource.resourceId, state);
    });

    if (!background) {
      const startWait = Date.now();
      while (state.view.status === "running" && Date.now() - startWait < timeoutMs) {
        await waitForShellYield(100);
      }
    }

    const output = drainPendingOutput(state);

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

    state.returnedToModel = true;
    this.scheduleInputDetection(resource.resourceId, state);
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
    state.view.lastInputAtMs = Date.now();
    state.inputDetectionSuppressedUntilMs = state.view.lastInputAtMs + this.config.shell.terminalEvents.inputSuppressionAfterWriteMs;
    state.lastInputPromptSignature = null;
    state.lastInputPromptNotifiedAtMs = null;
    await waitForShellYield(500);

    const output = drainPendingOutput(state);

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

    const output = drainPendingOutput(state);

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
      this.cancelInputDetection(state);
      state.closeEventSuppressed = true;
      state.kill("SIGKILL");
      this.sessions.delete(resourceId);
      void this.resourceRegistry.markStatus(resourceId, "closed", Date.now());
    }
  }

  isInputPromptCurrent(input: {
    resourceId: string;
    promptSignature: string;
    detectedAtMs: number;
  }): boolean {
    const state = this.sessions.get(input.resourceId);
    if (!state || state.view.status !== "running") {
      return false;
    }
    return state.lastInputPromptSignature === input.promptSignature
      && state.lastInputPromptNotifiedAtMs === input.detectedAtMs
      && (state.view.lastInputAtMs == null || state.view.lastInputAtMs < input.detectedAtMs);
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
      this.cancelInputDetection(state);
      state.closeEventSuppressed = true;
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

  private scheduleInputDetection(resourceId: string, state: InternalSessionState): void {
    if (!this.shouldDetectInput(state)) {
      return;
    }
    if (state.inputDetectionTimer) {
      clearTimeout(state.inputDetectionTimer);
    }
    state.inputDetectionTimer = setTimeout(() => {
      state.inputDetectionTimer = null;
      this.detectInputCandidate(resourceId, state);
    }, this.config.shell.terminalEvents.inputDetectionDebounceMs);
    state.inputDetectionTimer.unref?.();
  }

  private detectInputCandidate(resourceId: string, state: InternalSessionState): void {
    if (!this.shouldDetectInput(state)) {
      return;
    }

    const now = Date.now();
    if (now < state.inputDetectionSuppressedUntilMs) {
      this.scheduleSuppressionExpiryDetection(resourceId, state, state.inputDetectionSuppressedUntilMs - now);
      return;
    }

    const tail = trimOutputTail(state.view.outputTail, this.config.shell.terminalEvents.detectionTailMaxChars);
    const candidate = detectTerminalInputPrompt(tail);
    if (!candidate) {
      state.inputCandidateSignature = null;
      return;
    }

    if (
      state.lastInputPromptSignature === candidate.signature
      && state.lastInputPromptNotifiedAtMs != null
      && now - state.lastInputPromptNotifiedAtMs < this.config.shell.terminalEvents.inputPromptCooldownMs
    ) {
      return;
    }

    state.inputCandidateSignature = `${candidate.signature}:${this.buildTailSignature(state)}`;
    if (state.inputConfirmationTimer) {
      clearTimeout(state.inputConfirmationTimer);
    }
    state.inputConfirmationTimer = setTimeout(() => {
      state.inputConfirmationTimer = null;
      const currentTail = trimOutputTail(state.view.outputTail, this.config.shell.terminalEvents.detectionTailMaxChars);
      const currentCandidate = detectTerminalInputPrompt(currentTail);
      const currentSignature = currentCandidate
        ? `${currentCandidate.signature}:${this.buildTailSignature(state)}`
        : null;
      if (
        !currentCandidate
        || currentSignature !== state.inputCandidateSignature
        || !this.shouldDetectInput(state)
        || Date.now() < state.inputDetectionSuppressedUntilMs
      ) {
        return;
      }

      state.lastInputPromptSignature = currentCandidate.signature;
      state.lastInputPromptNotifiedAtMs = Date.now();
      state.view.lastInputPromptKind = currentCandidate.kind;
      state.view.lastInputPromptAtMs = state.lastInputPromptNotifiedAtMs;
      this.emitInputRequiredEvent(resourceId, state, currentCandidate.kind, currentCandidate.promptText, currentCandidate.signature);
    }, this.config.shell.terminalEvents.inputConfirmationMs);
    state.inputConfirmationTimer.unref?.();
  }

  private shouldDetectInput(state: InternalSessionState): boolean {
    return this.config.shell.terminalEvents.enabled
      && state.returnedToModel
      && state.view.status === "running"
      && state.owner != null
      && state.notifyPolicy === "notify_on_input_and_close";
  }

  private scheduleSuppressionExpiryDetection(resourceId: string, state: InternalSessionState, delayMs: number): void {
    if (state.inputDetectionTimer) {
      clearTimeout(state.inputDetectionTimer);
    }
    state.inputDetectionTimer = setTimeout(() => {
      state.inputDetectionTimer = null;
      this.detectInputCandidate(resourceId, state);
    }, Math.max(1, delayMs));
    state.inputDetectionTimer.unref?.();
  }

  private cancelInputDetection(state: InternalSessionState): void {
    if (state.inputDetectionTimer) {
      clearTimeout(state.inputDetectionTimer);
      state.inputDetectionTimer = null;
    }
    if (state.inputConfirmationTimer) {
      clearTimeout(state.inputConfirmationTimer);
      state.inputConfirmationTimer = null;
    }
    state.inputCandidateSignature = null;
  }

  private buildTailSignature(state: InternalSessionState): string {
    const tail = trimOutputTail(state.view.outputTail, this.config.shell.terminalEvents.detectionTailMaxChars);
    return normalizeTerminalOutput(tail).slice(-500);
  }

  private emitClosedEventIfNeeded(resourceId: string, state: InternalSessionState): void {
    if (
      !this.config.shell.terminalEvents.enabled
      || state.closeEventSuppressed
      || !state.returnedToModel
      || !state.owner
      || state.notifyPolicy === "none"
    ) {
      return;
    }
    const outputTruncated = state.pendingOutputTruncated;
    const output = drainPendingOutput(state);
    this.emitEvent({
      kind: "session_closed",
      owner: state.owner,
      resourceId,
      command: state.view.command,
      cwd: state.view.cwd,
      exitCode: state.view.exitCode,
      signal: state.view.signal,
      output,
      outputTruncated
    }, resourceId);
  }

  private emitInputRequiredEvent(
    resourceId: string,
    state: InternalSessionState,
    promptKind: NonNullable<ShellSession["lastInputPromptKind"]>,
    promptText: string,
    promptSignature: string
  ): void {
    if (!state.owner || state.lastInputPromptNotifiedAtMs == null) {
      return;
    }
    this.emitEvent({
      kind: "input_required",
      owner: state.owner,
      resourceId,
      command: state.view.command,
      cwd: state.view.cwd,
      promptKind,
      promptText,
      promptSignature,
      detectedAtMs: state.lastInputPromptNotifiedAtMs,
      outputTail: trimOutputTail(state.view.outputTail, this.config.shell.terminalEvents.detectionTailMaxChars)
    }, resourceId);
  }

  private emitEvent(event: ShellRuntimeEvent, resourceId: string): void {
    if (!this.eventHandler) {
      return;
    }
    void Promise.resolve(this.eventHandler(event)).catch((error: unknown) => {
      this.logger.error({ error, resourceId }, "shell_runtime_event_dispatch_failed");
    });
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

function drainPendingOutput(state: InternalSessionState): string {
  const output = state.pendingOutput;
  const truncated = state.pendingOutputTruncated;
  state.pendingOutput = "";
  state.pendingOutputTruncated = false;
  if (truncated) {
    return `[输出过长，已截取最后部分内容]\n${output}`;
  }
  return output;
}
