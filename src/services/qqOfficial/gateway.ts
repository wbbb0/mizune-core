import WebSocket from "ws";
import type { Logger } from "pino";
import type { QqHttpClient } from "./httpClient.ts";

interface GatewayPayload { op: number; s?: number; t?: string; d?: unknown; }

export class QqGateway {
  private socket: WebSocket | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private generation = 0;
  private attempt = 0;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private heartbeatAcknowledged = true;
  private handshakeWatchdog: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly http: QqHttpClient,
    private readonly logger: Logger,
    private readonly dispatch: (type: string, data: unknown) => void,
    private readonly makeSocket: (url: string) => WebSocket = (url) => new WebSocket(url, { maxPayload: 4 * 1024 * 1024, handshakeTimeout: http.timeoutMs }),
    private readonly handshakeTimeoutMs: number = http.timeoutMs
  ) {}

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    if (this.reconnect) clearTimeout(this.reconnect);
    this.reconnect = null;
    this.teardown();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const generation = ++this.generation;
    try {
      const gateway = await this.http.request<{ url: string }>("GET", "/gateway/bot");
      const url = new URL(gateway.url);
      if (url.protocol !== "wss:" || url.hostname !== "api.bot.qq.com" || url.username || url.password) {
        throw new Error("非法官方 Bot 网关地址");
      }
      const token = await this.http.accessToken();
      if (this.stopped || generation !== this.generation) return;
      const socket = this.makeSocket(url.toString());
      this.socket = socket;
      this.armHandshakeWatchdog(socket, generation);
      socket.on("message", (raw) => {
        if (generation !== this.generation || socket !== this.socket) return;
        let payload: GatewayPayload;
        try { payload = JSON.parse(raw.toString()) as GatewayPayload; }
        catch { this.logger.warn("qq_official_gateway_invalid_json"); return; }
        if (!payload || typeof payload !== "object" || typeof payload.op !== "number") return;
        if (payload == null || typeof payload !== "object" || Array.isArray(payload) || !Number.isInteger(payload.op)) {
          this.logger.warn("qq_official_gateway_invalid_payload"); return;
        }
        if (typeof payload.s === "number" && Number.isSafeInteger(payload.s) && payload.s >= 0) this.sequence = payload.s;
        if (payload.op === 10) {
          this.armHandshakeWatchdog(socket, generation);
          const interval = Number((payload.d as { heartbeat_interval?: unknown } | undefined)?.heartbeat_interval);
          if (!Number.isFinite(interval) || interval < 1000 || interval > 300_000) { socket.close(); return; }
          if (this.heartbeat) clearInterval(this.heartbeat);
          this.heartbeatAcknowledged = true;
          this.heartbeat = setInterval(() => {
            if (!this.heartbeatAcknowledged) { socket.terminate(); return; }
            this.heartbeatAcknowledged = false;
            this.send({ op: 1, d: this.sequence });
          }, interval);
          this.heartbeat.unref();
          this.send(this.sessionId && this.sequence != null ? {
            op: 6, d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.sequence }
          } : {
            op: 2, d: { token: `QQBot ${token}`, intents: 1 << 25, shard: [0, 1], properties: {} }
          });
        } else if (payload.op === 11) {
          this.heartbeatAcknowledged = true;
        } else if (payload.op === 7) {
          socket.close();
        } else if (payload.op === 9) {
          this.sessionId = null;
          this.sequence = null;
          socket.close();
        } else if (payload.op === 0 && typeof payload.t === "string") {
          if (payload.t === "READY") {
            const sessionId = (payload.d as { session_id?: unknown } | undefined)?.session_id;
            this.sessionId = typeof sessionId === "string" ? sessionId : null;
            this.clearHandshakeWatchdog();
            this.attempt = 0;
          } else if (payload.t === "RESUMED") { this.clearHandshakeWatchdog(); this.attempt = 0; }
          try { this.dispatch(payload.t, payload.d); }
          catch { this.logger.warn("qq_official_dispatch_failed"); }
        }
      });
      socket.on("error", () => { this.logger.warn("qq_official_gateway_transport_error"); socket.terminate(); });
      socket.on("close", (code) => {
        if (generation !== this.generation) return;
        if (code === 4004 || code === 4914) {
          this.http.invalidateToken(); this.sessionId = null; this.sequence = null;
        }
        this.teardown();
        this.scheduleReconnect();
      });
    } catch {
      this.logger.warn("qq_official_gateway_connect_failed");
      if (generation === this.generation) this.scheduleReconnect();
    }
  }

  private send(payload: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(payload));
  }

  private clearHandshakeWatchdog(): void {
    if (this.handshakeWatchdog) clearTimeout(this.handshakeWatchdog);
    this.handshakeWatchdog = null;
  }

  private armHandshakeWatchdog(socket: WebSocket, generation: number): void {
    this.clearHandshakeWatchdog();
    this.handshakeWatchdog = setTimeout(() => {
      this.handshakeWatchdog = null;
      if (this.stopped || generation !== this.generation || socket !== this.socket) return;
      this.logger.warn("qq_official_gateway_handshake_timeout");
      socket.terminate();
    }, this.handshakeTimeoutMs);
    this.handshakeWatchdog.unref();
  }

  private teardown(): void {
    this.clearHandshakeWatchdog();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) { socket.removeAllListeners(); socket.on("error", () => undefined); socket.terminate(); }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnect) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt++, 5));
    this.reconnect = setTimeout(() => { this.reconnect = null; void this.connect(); }, delay);
    this.reconnect.unref();
  }
}
