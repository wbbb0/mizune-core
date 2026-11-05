import { fetch as undiciFetch } from "undici";
import { QqDeliveryError, type QqOfficialConfig } from "./types.ts";

export interface QqHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type QqFetch = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: string | Buffer;
  signal: AbortSignal;
  redirect: "error";
}) => Promise<QqHttpResponse>;

export class QqHttpClient {
  private token: { value: string; refreshAt: number } | null = null;
  private refreshing: Promise<string> | null = null;
  readonly timeoutMs: number;

  constructor(
    readonly config: QqOfficialConfig,
    private readonly fetchImpl: QqFetch = undiciFetch as QqFetch,
    private readonly now: () => number = Date.now
  ) {
    this.timeoutMs = config.requestTimeoutMs ?? 15_000;
  }

  invalidateToken(): void { this.token = null; }

  async accessToken(): Promise<string> {
    if (!this.config.appId.trim() || !this.config.appSecret.trim()) throw new QqDeliveryError("rejected", "missing_credentials");
    if (this.token && this.now() < this.token.refreshAt) return this.token.value;
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.fetchToken();
    try { return await this.refreshing; }
    finally { this.refreshing = null; }
  }

  private async fetchToken(): Promise<string> {
    const data = await this.perform("https://bots.qq.com/app/getAppAccessToken", "POST", {
      appId: this.config.appId, clientSecret: this.config.appSecret
    }, {});
    const value = data.access_token;
    const expires = Number(data.expires_in);
    if (typeof value !== "string" || !value || !Number.isFinite(expires) || expires <= 0) {
      throw new QqDeliveryError("rejected", "invalid_token_response");
    }
    this.token = { value, refreshAt: this.now() + Math.max(1, expires * 1000 - Math.min(60_000, expires * 100)) };
    return value;
  }

  async request<T>(method: string, path: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("?")) throw new Error("非法 QQ API 路径");
    signal?.throwIfAborted();
    const token = await this.accessToken();
    signal?.throwIfAborted();
    try {
      return await this.perform(`https://api.bot.qq.com${path}`, method, body, {
        Authorization: `QQBot ${token}`, "X-Union-Appid": this.config.appId
      }, signal) as T;
    } catch (error) {
      // Mutations are never replayed after authentication errors.
      if (error instanceof QqDeliveryError && error.httpStatus === 401) this.invalidateToken();
      throw error;
    }
  }

  async putPart(url: string, bytes: Buffer, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new QqDeliveryError("rejected", "invalid_upload_url");
    // A signed upload URL receives only file bytes, never the API authorization header.
    let response: QqHttpResponse;
    try {
      response = await this.fetchImpl(url, {
        method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: bytes,
        signal: this.signal(signal), redirect: "error"
      });
    } catch { throw new QqDeliveryError("unknown", "upload_transport"); }
    if (!response.ok) throw new QqDeliveryError(response.status >= 500 ? "unknown" : "rejected", "upload_http", response.status);
  }

  private signal(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  private async perform(url: string, method: string, body: Record<string, unknown> | undefined,
    headers: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    let response: QqHttpResponse;
    try {
      response = await this.fetchImpl(url, {
        method, headers: { "Content-Type": "application/json", ...headers },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: this.signal(signal), redirect: "error"
      });
    } catch { throw new QqDeliveryError("unknown", "transport"); }
    let data: unknown;
    try { data = response.status === 204 ? {} : await response.json(); }
    catch { throw new QqDeliveryError(response.ok || response.status >= 500 ? "unknown" : "rejected", "invalid_response", response.status); }
    const record = data != null && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
    const errorCode = record?.err_code ?? record?.code;
    if (!response.ok || (errorCode != null && String(errorCode) !== "0")) {
      const code = typeof errorCode === "number" || (typeof errorCode === "string" && /^\d+$/.test(errorCode)) ? String(errorCode) : "http_error";
      throw new QqDeliveryError(response.status >= 500 ? "unknown" : "rejected", code, response.status);
    }
    if (!record) throw new QqDeliveryError("unknown", "invalid_response", response.status);
    return record;
  }
}
