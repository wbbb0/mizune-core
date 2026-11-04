import { randomUUID } from "node:crypto";

const transportCodes = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]);
const retryCodes = new Set(["ECONNREFUSED", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);
export interface RequestDiagnostic {
  requestId: string;
  stage: "connect" | "response" | "body" | "provider";
  elapsedMs: number;
  attempt: number;
  statusCode?: number;
  causeCodes: string[];
  retryable: boolean;
  willRetry: boolean;
}
const diagnostics = new WeakMap<object, RequestDiagnostic>();
/** Error messages, URLs and arbitrary properties never enter this projection. */
export function safeCauseCodes(error: unknown): string[] {
  const codes = new Set<string>();
  const seen = new Set<object>();
  const queue: unknown[] = [error];
  for (let index = 0; index < queue.length && index < 16; index++) {
    const item = queue[index];
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    const value = item as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof value.code === "string" && transportCodes.has(value.code)) codes.add(value.code);
    if (value.cause) queue.push(value.cause);
    if (Array.isArray(value.errors)) queue.push(...value.errors.slice(0, 8));
  }
  return [...codes];
}
function onlyTemporaryCauses(error: unknown): boolean {
  const queue: unknown[] = [error];
  const seen = new Set<object>();
  let classified = false;
  for (let i = 0; i < queue.length; i++) {
    if (i >= 16) return false;
    const value = queue[i];
    if (!value || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    const item = value as { code?: unknown; cause?: unknown; errors?: unknown };
    if (item.code !== undefined) {
      if (typeof item.code !== "string" || !retryCodes.has(item.code)) return false;
      classified = true;
    }
    const nested = [...(item.cause ? [item.cause] : []), ...(Array.isArray(item.errors) ? item.errors : [])];
    if (!nested.length && item.code === undefined) return false;
    queue.push(...nested.slice(0, 17));
  }
  return classified;
}
export function getRequestDiagnostic(error: unknown): RequestDiagnostic | undefined {
  return error !== null && typeof error === "object" ? diagnostics.get(error) : undefined;
}
export function attachRequestDiagnostic(error: unknown, diagnostic: RequestDiagnostic): void {
  if (error !== null && typeof error === "object") diagnostics.set(error, diagnostic);
}
/** Retry only before headers, once, for explicit temporary transport failures. */
export async function requestWithDiagnostics<T>(
  run: () => Promise<T>, signal: AbortSignal | null | undefined,
  observe: (diagnostic: RequestDiagnostic) => void = () => {},
  allowRetry = true
): Promise<T> {
  const requestId = randomUUID();
  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    try {
      const result = await run();
      const statusCode = result && typeof result === "object" && "status" in result && typeof result.status === "number" ? result.status : undefined;
      attachRequestDiagnostic(result, { requestId, stage: "response", elapsedMs: Date.now() - started, attempt, causeCodes: [], retryable: false, willRetry: false, ...(statusCode ? { statusCode } : {}) });
      return result;
    }
    catch (error) {
      const causeCodes = safeCauseCodes(error);
      const retryable = !signal?.aborted && onlyTemporaryCauses(error);
      const diagnostic: RequestDiagnostic = { requestId, stage: "connect", elapsedMs: Date.now() - started, attempt, causeCodes, retryable, willRetry: allowRetry && retryable && attempt === 1 };
      attachRequestDiagnostic(error, diagnostic);
      observe(diagnostic);
      if (!diagnostic.willRetry) throw error;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); reject(signal?.reason); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, 150);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    }
  }
}

/** Strict projection also used for untrusted serialized tool envelopes. */
export function projectRequestDiagnostic(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const d = value as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  if (typeof d.requestId === "string" && /^[a-f0-9-]{36}$/.test(d.requestId)) safe.requestId = d.requestId;
  if (typeof d.stage === "string" && ["connect", "response", "body", "provider"].includes(d.stage)) safe.stage = d.stage;
  for (const key of ["elapsedMs", "attempt", "statusCode"]) {
    if (typeof d[key] === "number" && Number.isFinite(d[key]) && d[key] >= 0) safe[key] = d[key];
  }
  for (const key of ["retryable", "willRetry"]) if (typeof d[key] === "boolean") safe[key] = d[key];
  if (Array.isArray(d.causeCodes)) safe.causeCodes = d.causeCodes.filter(code => typeof code === "string" && transportCodes.has(code)).slice(0, 16);
  return safe;
}
export function diagnosticFromToolResult(result: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(result) as { detail?: { requestDiagnostic?: unknown } };
    return projectRequestDiagnostic(parsed?.detail?.requestDiagnostic);
  } catch { return undefined; }
}
