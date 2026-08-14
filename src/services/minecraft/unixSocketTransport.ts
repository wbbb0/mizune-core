import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import type {
  MinecraftActorRpcMethod,
  MinecraftActorTransport,
  MinecraftRuntimeCapabilities
} from "./actorClient.ts";

const KNOWN_RPC_METHODS = new Set<MinecraftActorRpcMethod>([
  "actor.get_snapshot",
  "observation.get",
  "behavior.start",
  "behavior.cancel",
  "task.submit",
  "task.cancel",
  "autonomy.set_policy",
  "program.get_active",
  "program.validate",
  "program.activate",
  "events.list"
]);
const KNOWN_OBSERVATION_SCOPES = new Set<MinecraftRuntimeCapabilities["observationScopes"][number]>([
  "self",
  "environment",
  "inventory",
  "entities",
  "player",
  "chat",
  "tasks"
]);

export interface UnixSocketMinecraftActorTransportOptions {
  socketPath: string;
  actorId: string;
  requestTimeoutMs: number;
  connectTimeoutMs: number;
  maxFrameBytes: number;
  clientName?: string;
  clientVersion?: string;
  runtimeInstanceId?: string;
  authTokenFile?: string;
  resolveRuntimeCredentials?: () => Promise<{
    runtimeInstanceId: string;
    authTokenFile: string;
  }>;
  now?: () => number;
}

interface PendingResponse {
  resolve: (message: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

interface TransportCapabilities extends MinecraftRuntimeCapabilities {
  heartbeatIntervalMs: number;
  controllerLeaseTtlMs: number;
  maxFrameBytes: number;
  features: string[];
}

class MinecraftTransportDisconnectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MinecraftTransportDisconnectedError";
  }
}

export class MinecraftActorRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "MinecraftActorRpcError";
  }
}

export class UnixSocketMinecraftActorTransport implements MinecraftActorTransport {
  private readonly socketPath: string;
  private readonly actorId: string;
  private readonly requestTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly configuredMaxFrameBytes: number;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly runtimeInstanceId: string | null;
  private readonly authTokenFile: string | null;
  private readonly resolveRuntimeCredentials: UnixSocketMinecraftActorTransportOptions["resolveRuntimeCredentials"];
  private readonly controllerId = randomUUID();
  private readonly now: () => number;
  private readonly pending = new Map<string, PendingResponse>();
  private readonly abandonedResponseIds = new Set<string>();
  private socket: Socket | null = null;
  private connectOperation: Promise<void> | null = null;
  private receiveBuffer = Buffer.alloc(0);
  private sessionId: string | null = null;
  private capabilities: TransportCapabilities | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatInFlight = false;
  private closed = false;

  constructor(options: UnixSocketMinecraftActorTransportOptions) {
    this.socketPath = requireNonEmpty(options.socketPath, "socketPath");
    this.actorId = requireNonEmpty(options.actorId, "actorId");
    this.requestTimeoutMs = requirePositiveInteger(options.requestTimeoutMs, "requestTimeoutMs");
    this.connectTimeoutMs = requirePositiveInteger(options.connectTimeoutMs, "connectTimeoutMs");
    this.configuredMaxFrameBytes = requirePositiveInteger(options.maxFrameBytes, "maxFrameBytes");
    this.clientName = options.clientName ?? "mizune-core";
    this.clientVersion = options.clientVersion ?? "1";
    this.runtimeInstanceId = options.runtimeInstanceId?.trim() || null;
    this.authTokenFile = options.authTokenFile?.trim() || null;
    this.resolveRuntimeCredentials = options.resolveRuntimeCredentials;
    this.now = options.now ?? Date.now;
  }

  async call(
    method: MinecraftActorRpcMethod,
    payload: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (this.closed) throw new Error("Minecraft Unix socket transport 已关闭");
    throwIfAborted(signal);
    const requestId = randomUUID();
    const deadlineAtMs = this.now() + this.requestTimeoutMs;
    let attempt = 0;
    while (true) {
      attempt += 1;
      try {
        await this.ensureConnected(signal);
        const sessionId = this.sessionId;
        if (!sessionId) throw new MinecraftTransportDisconnectedError("Minecraft Runtime 会话尚未建立");
        if (!this.capabilities?.rpcMethods.includes(method)) {
          throw new Error(`Minecraft Runtime 不支持 RPC 方法：${method}`);
        }
        const message = await this.sendAndWait({
          type: "request",
          requestId,
          sessionId,
          method,
          deadlineAtMs,
          payload
        }, requestId, deadlineAtMs, signal);
        if (message.type !== "response") {
          throw new Error(`Minecraft Runtime 返回了错误的响应类型：${String(message.type)}`);
        }
        if (message.ok === true) return message.result;
        const error = isRecord(message.error) ? message.error : {};
        throw new MinecraftActorRpcError(
          typeof error.code === "string" ? error.code : "rpc_error",
          typeof error.message === "string" ? error.message : "Minecraft Runtime RPC 失败",
          error.retryable === true
        );
      } catch (error) {
        if (
          error instanceof MinecraftTransportDisconnectedError
          && attempt < 2
          && !this.closed
          && !signal?.aborted
          && this.now() < deadlineAtMs
        ) {
          continue;
        }
        throw error;
      }
    }
  }

  async getCapabilities(signal?: AbortSignal): Promise<MinecraftRuntimeCapabilities> {
    if (this.closed) throw new Error("Minecraft Unix socket transport 已关闭");
    await this.ensureConnected(signal);
    const capabilities = this.capabilities;
    if (!capabilities) throw new MinecraftTransportDisconnectedError("Minecraft Runtime capability 尚未建立");
    return {
      rpcMethods: [...capabilities.rpcMethods],
      observationScopes: [...capabilities.observationScopes],
      behaviorCapabilities: [...capabilities.behaviorCapabilities],
      runtimeFeatures: [...capabilities.runtimeFeatures]
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopHeartbeat();
    const error = new MinecraftTransportDisconnectedError("Minecraft Unix socket transport 已关闭");
    this.rejectAllPending(error);
    const socket = this.socket;
    this.socket = null;
    this.sessionId = null;
    this.capabilities = null;
    if (socket && !socket.destroyed) {
      await new Promise<void>(resolve => {
        socket.once("close", () => resolve());
        socket.destroy();
      });
    }
  }

  async releaseController(): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId || this.closed) return;
    const requestId = randomUUID();
    const response = await this.sendAndWait({
      type: "release",
      requestId,
      sessionId
    }, requestId, this.now() + this.requestTimeoutMs);
    if (response.type !== "release_ack" || response.sessionId !== sessionId) {
      throw new Error("Minecraft Runtime release 响应无效");
    }
    this.sessionId = null;
    this.capabilities = null;
    this.stopHeartbeat();
  }

  private async ensureConnected(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (this.closed) throw new Error("Minecraft Unix socket transport 已关闭");
    if (this.socket && !this.socket.destroyed && this.sessionId) return;
    const existing = this.connectOperation;
    if (existing) return raceAbort(existing, signal);
    const operation = this.connect();
    this.connectOperation = operation;
    try {
      await raceAbort(operation, signal);
    } finally {
      if (this.connectOperation === operation) this.connectOperation = null;
    }
  }

  private async connect(): Promise<void> {
    if (this.closed) throw new Error("Minecraft Unix socket transport 已关闭");
    const credentials = await this.getRuntimeCredentials();
    this.resetSocket(new MinecraftTransportDisconnectedError("正在重新建立 Minecraft Runtime 连接"));
    const socket = createConnection({ path: this.socketPath });
    this.socket = socket;
    this.receiveBuffer = Buffer.alloc(0);
    socket.setNoDelay(true);
    socket.on("data", chunk => this.handleData(
      socket,
      typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk
    ));
    socket.on("error", error => this.handleSocketFailure(socket, error));
    socket.on("close", () => this.handleSocketFailure(
      socket,
      new MinecraftTransportDisconnectedError("Minecraft Runtime 连接已断开")
    ));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        socket.destroy();
        reject(new MinecraftTransportDisconnectedError("连接 Minecraft Runtime 超时"));
      }, this.connectTimeoutMs);
      timeout.unref?.();
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(new MinecraftTransportDisconnectedError(`连接 Minecraft Runtime 失败：${error.message}`));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        socket.off("connect", onConnect);
        socket.off("error", onError);
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
    });

    if (this.socket !== socket || socket.destroyed) {
      throw new MinecraftTransportDisconnectedError("Minecraft Runtime 在握手前断开");
    }
    const requestId = randomUUID();
    const deadlineAtMs = this.now() + this.connectTimeoutMs;
    const authToken = credentials.authTokenFile === null
      ? null
      : (await readFile(credentials.authTokenFile, "utf8")).trim();
    if (authToken !== null && (!authToken || authToken.length > 512)) {
      throw new Error("Minecraft Runtime auth token 无效");
    }
    const hello = await this.sendAndWait({
      type: "hello",
      requestId,
      supportedProtocolVersions: [1],
      actorId: this.actorId,
      clientName: this.clientName,
      clientVersion: this.clientVersion,
      controllerId: this.controllerId,
      ...(authToken === null ? {} : { authToken })
    }, requestId, deadlineAtMs);
    if (hello.type === "error") {
      const error = isRecord(hello.error) ? hello.error : {};
      throw new MinecraftActorRpcError(
        typeof error.code === "string" ? error.code : "hello_failed",
        typeof error.message === "string" ? error.message : "Minecraft Runtime 握手失败",
        false
      );
    }
    if (hello.type !== "hello_result" || hello.protocolVersion !== 1 || hello.actorId !== this.actorId) {
      throw new Error("Minecraft Runtime hello 响应与请求不匹配");
    }
    if (
      credentials.runtimeInstanceId !== null
      && hello.runtimeInstanceId !== credentials.runtimeInstanceId
    ) {
      throw new Error("Minecraft Runtime instance 身份与受管进程不匹配");
    }
    const sessionId = requireNonEmptyValue(hello.sessionId, "hello.sessionId");
    const capabilities = parseCapabilities(hello.capabilities, this.configuredMaxFrameBytes);
    this.sessionId = sessionId;
    this.capabilities = capabilities;
    this.startHeartbeat(capabilities.heartbeatIntervalMs);
  }

  private async getRuntimeCredentials(): Promise<{
    runtimeInstanceId: string | null;
    authTokenFile: string | null;
  }> {
    if (!this.resolveRuntimeCredentials) {
      return {
        runtimeInstanceId: this.runtimeInstanceId,
        authTokenFile: this.authTokenFile
      };
    }
    const resolved = await this.resolveRuntimeCredentials();
    return {
      runtimeInstanceId: requireNonEmpty(resolved.runtimeInstanceId, "runtimeInstanceId"),
      authTokenFile: requireNonEmpty(resolved.authTokenFile, "authTokenFile")
    };
  }

  private sendAndWait(
    message: Record<string, unknown>,
    requestId: string,
    deadlineAtMs: number,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      return Promise.reject(new MinecraftTransportDisconnectedError("Minecraft Runtime 未连接"));
    }
    if (this.pending.has(requestId)) {
      return Promise.reject(new Error(`Minecraft Runtime requestId 正在使用：${requestId}`));
    }
    const remainingMs = deadlineAtMs - this.now();
    if (remainingMs <= 0) return Promise.reject(new Error("Minecraft Runtime 请求在发送前已过期"));
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(requestId);
        callback();
      };
      const onAbort = () => {
        this.abandonRequest(requestId);
        this.sendCancelBestEffort(requestId);
        settle(() => reject(abortError(signal)));
      };
      const timeout = setTimeout(() => {
        this.abandonRequest(requestId);
        this.sendCancelBestEffort(requestId);
        settle(() => reject(new Error("Minecraft Runtime 请求超时")));
      }, remainingMs);
      timeout.unref?.();
      this.pending.set(requestId, {
        resolve: response => settle(() => resolve(response)),
        reject: error => settle(() => reject(error))
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        socket.write(this.encodeFrame(message));
      } catch (error) {
        settle(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });
  }

  private sendCancelBestEffort(targetRequestId: string): void {
    const socket = this.socket;
    const sessionId = this.sessionId;
    if (!socket || socket.destroyed || !sessionId) return;
    const requestId = randomUUID();
    this.abandonedResponseIds.add(requestId);
    try {
      socket.write(this.encodeFrame({
        type: "cancel",
        requestId,
        sessionId,
        targetRequestId
      }));
    } catch {
      this.abandonedResponseIds.delete(requestId);
    }
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.sendHeartbeat();
    }, intervalMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.heartbeatInFlight = false;
  }

  private async sendHeartbeat(): Promise<void> {
    if (this.heartbeatInFlight || this.closed) return;
    const sessionId = this.sessionId;
    if (!sessionId) return;
    this.heartbeatInFlight = true;
    const requestId = randomUUID();
    const deadlineAtMs = this.now() + Math.min(
      this.requestTimeoutMs,
      this.capabilities?.controllerLeaseTtlMs ?? this.requestTimeoutMs
    );
    try {
      const response = await this.sendAndWait({
        type: "heartbeat",
        requestId,
        sessionId
      }, requestId, deadlineAtMs);
      if (response.type !== "heartbeat_ack" || response.sessionId !== sessionId) {
        throw new Error("Minecraft Runtime heartbeat 响应无效");
      }
    } catch (error) {
      const socket = this.socket;
      if (socket) this.handleSocketFailure(socket, error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.heartbeatInFlight = false;
    }
  }

  private handleData(socket: Socket, chunk: Buffer): void {
    if (this.socket !== socket) return;
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);
    const maxFrameBytes = Math.min(
      this.configuredMaxFrameBytes,
      this.capabilities?.maxFrameBytes ?? this.configuredMaxFrameBytes
    );
    while (this.receiveBuffer.length >= 4) {
      const length = this.receiveBuffer.readUInt32BE(0);
      if (length <= 0 || length > maxFrameBytes) {
        this.handleProtocolFailure(socket, `Minecraft Runtime frame 长度越界：${length}`);
        return;
      }
      if (this.receiveBuffer.length < length + 4) return;
      const body = this.receiveBuffer.subarray(4, length + 4);
      this.receiveBuffer = this.receiveBuffer.subarray(length + 4);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        this.handleProtocolFailure(socket, "Minecraft Runtime 返回了无效 JSON");
        return;
      }
      if (!isRecord(parsed) || typeof parsed.requestId !== "string") {
        this.handleProtocolFailure(socket, "Minecraft Runtime 响应缺少 requestId");
        return;
      }
      const requestId = parsed.requestId;
      const pending = this.pending.get(requestId);
      if (pending) {
        pending.resolve(parsed);
        continue;
      }
      if (this.abandonedResponseIds.delete(requestId)) continue;
      this.handleProtocolFailure(socket, `Minecraft Runtime 返回未知 requestId：${requestId}`);
      return;
    }
  }

  private handleProtocolFailure(socket: Socket, message: string): void {
    this.handleSocketFailure(socket, new Error(message));
  }

  private handleSocketFailure(socket: Socket, cause: Error): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.sessionId = null;
    this.capabilities = null;
    this.receiveBuffer = Buffer.alloc(0);
    this.stopHeartbeat();
    if (!socket.destroyed) socket.destroy();
    const error = cause instanceof MinecraftTransportDisconnectedError
      ? cause
      : new MinecraftTransportDisconnectedError(cause.message);
    this.rejectAllPending(error);
  }

  private resetSocket(error: Error): void {
    const socket = this.socket;
    this.socket = null;
    this.sessionId = null;
    this.capabilities = null;
    this.receiveBuffer = Buffer.alloc(0);
    this.stopHeartbeat();
    this.rejectAllPending(error);
    if (socket && !socket.destroyed) socket.destroy();
  }

  private rejectAllPending(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const item of pending) item.reject(error);
  }

  private abandonRequest(requestId: string): void {
    this.abandonedResponseIds.add(requestId);
    if (this.abandonedResponseIds.size > 1_024) {
      const oldest = this.abandonedResponseIds.values().next().value as string | undefined;
      if (oldest) this.abandonedResponseIds.delete(oldest);
    }
  }

  private encodeFrame(message: Record<string, unknown>): Buffer {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const maxFrameBytes = Math.min(
      this.configuredMaxFrameBytes,
      this.capabilities?.maxFrameBytes ?? this.configuredMaxFrameBytes
    );
    if (body.length <= 0 || body.length > maxFrameBytes) {
      throw new Error(`Minecraft Runtime 请求 frame 长度越界：${body.length}`);
    }
    const frame = Buffer.allocUnsafe(body.length + 4);
    frame.writeUInt32BE(body.length, 0);
    body.copy(frame, 4);
    return frame;
  }
}

function parseCapabilities(value: unknown, configuredMaxFrameBytes: number): TransportCapabilities {
  if (!isRecord(value)) throw new Error("Minecraft Runtime hello.capabilities 无效");
  const heartbeatIntervalMs = requirePositiveInteger(value.heartbeatIntervalMs, "heartbeatIntervalMs");
  const controllerLeaseTtlMs = requirePositiveInteger(value.controllerLeaseTtlMs, "controllerLeaseTtlMs");
  const maxFrameBytes = requirePositiveInteger(value.maxFrameBytes, "maxFrameBytes");
  if (maxFrameBytes > configuredMaxFrameBytes) {
    // The local limit remains authoritative; a larger remote capability is fine.
  }
  const rpcMethods = requireStringArray(value.rpcMethods, "rpcMethods", 64, 128)
    .filter((method): method is MinecraftActorRpcMethod => KNOWN_RPC_METHODS.has(method as MinecraftActorRpcMethod));
  const observationScopes = requireStringArray(value.observationScopes, "observationScopes", 32, 128)
    .filter((scope): scope is MinecraftRuntimeCapabilities["observationScopes"][number] => (
      KNOWN_OBSERVATION_SCOPES.has(scope as MinecraftRuntimeCapabilities["observationScopes"][number])
    ));
  const behaviorCapabilities = requireStringArray(
    value.behaviorCapabilities,
    "behaviorCapabilities",
    128,
    256
  );
  const runtimeFeatures = requireStringArray(value.runtimeFeatures, "runtimeFeatures", 128, 256);
  const features = requireStringArray(value.features, "features", 64, 128);
  for (const required of [
    "request_deadline@1",
    "durable_idempotency@1",
    "event_cursor@1",
    "control_lease@1"
  ]) {
    if (!features.includes(required)) throw new Error(`Minecraft Runtime 缺少必要能力：${required}`);
  }
  if (controllerLeaseTtlMs <= heartbeatIntervalMs) {
    throw new Error("Minecraft Runtime control lease 必须长于 heartbeat 间隔");
  }
  return {
    heartbeatIntervalMs,
    controllerLeaseTtlMs,
    maxFrameBytes,
    rpcMethods,
    observationScopes,
    behaviorCapabilities,
    runtimeFeatures,
    features
  };
}

function requireStringArray(value: unknown, name: string, maxItems: number, maxLength: number): string[] {
  if (
    !Array.isArray(value)
    || value.length > maxItems
    || value.some(item => typeof item !== "string" || !item.trim() || item.length > maxLength)
  ) {
    throw new Error(`Minecraft Runtime ${name} 无效`);
  }
  return [...new Set(value)];
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${name} 必须是正整数`);
  return Number(value);
}

function requireNonEmpty(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} 不能为空`);
  return normalized;
}

function requireNonEmptyValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} 不能为空`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(String(signal?.reason ?? "aborted"));
  error.name = "AbortError";
  return error;
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        cleanup();
        resolve(value);
      },
      error => {
        cleanup();
        reject(error);
      }
    );
  });
}
