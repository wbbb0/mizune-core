import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Response } from "undici";
import { fetchWithProxy } from "#services/proxy/index.ts";
import type { LlmProviderRequestContext } from "./providerTypes.ts";

import { requestWithDiagnostics, getRequestDiagnostic, attachRequestDiagnostic, safeCauseCodes, type RequestDiagnostic } from "./requestDiagnostics.ts";

const activeDiagnosticLogger = new AsyncLocalStorage<Partial<Pick<LlmProviderRequestContext, "logger">> & { latest?: RequestDiagnostic; started?: number; allowRetry: boolean }>();

const BODY_LIMIT = 1024 * 1024;
interface Exchange {
  endpoint: string;
  requestBody: string | null;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body: Buffer[];
  capturedBytes: number;
  receivedBytes: number;
  bodyComplete: boolean;
  transportError?: { name: string; message: string };
}
const activeExchanges = new AsyncLocalStorage<Exchange[]>();

function describeError(error: unknown): { name: string; message: string; statusCode?: number } {
  return error instanceof Error
    ? { name: error.name, message: error.message, ...("statusCode" in error && typeof error.statusCode === "number" ? { statusCode: error.statusCode } : {}) }
    : { name: "Error", message: String(error) };
}

function diagnosticEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  url.username = "";
  url.password = "";
  for (const name of [...url.searchParams.keys()]) {
    if (/^(key|api[_-]?key|token|access_token|signature)$/i.test(name)) {
      url.searchParams.set(name, "[REDACTED]");
    }
  }
  return url.toString();
}

/** Capture the bytes consumed by providers, before SSE/JSON parsing, without a tee or extra read. */
export async function fetchProviderResponse(...args: Parameters<typeof fetchWithProxy>): ReturnType<typeof fetchWithProxy> {
  const exchanges = activeExchanges.getStore();
  const fetchRequest = () => requestWithDiagnostics(() => fetchWithProxy(...args), args[3]?.signal, diagnostic => {
    activeDiagnosticLogger.getStore()?.logger?.warn({ requestDiagnostic: diagnostic, modelRef: args[4]?.modelRef }, "llm_request_transport_failed");
  }, args[1] === "llm" && activeDiagnosticLogger.getStore()?.allowRetry === true);

  const exchange: Exchange = {
    endpoint: diagnosticEndpoint(args[2]),
    requestBody: typeof args[3]?.body === "string" ? args[3].body : null,
    body: [], capturedBytes: 0, receivedBytes: 0, bodyComplete: false
  };
  exchanges?.push(exchange);
  try {
    const response = await fetchRequest();
    const scope = activeDiagnosticLogger.getStore();
    if (scope) { scope.latest = getRequestDiagnostic(response)!; scope.started = Date.now() - (scope.latest?.elapsedMs ?? 0); }
    exchange.status = response.status;
    exchange.statusText = response.statusText;
    exchange.headers = {};
    // Never dump authentication headers or cookies.
    for (const name of ["content-type", "x-request-id", "request-id", "retry-after"]) {
      const value = response.headers.get(name);
      if (value != null) exchange.headers[name] = value;
    }
    if (!response.body) {
      exchange.bodyComplete = true;
      return response;
    }
    const responseDiagnostic = getRequestDiagnostic(response)!;
    const responseStarted = Date.now() - responseDiagnostic.elapsedMs;
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            exchange.bodyComplete = true;
            reader.releaseLock();
            controller.close();
            return;
          }
          exchange.receivedBytes += value.byteLength;
          const retained = value.subarray(0, Math.max(0, BODY_LIMIT - exchange.capturedBytes));
          if (exchanges && retained.byteLength) {
            exchange.body.push(Buffer.from(retained));
            exchange.capturedBytes += retained.byteLength;
          }
          controller.enqueue(value);
        } catch (error) {
          exchange.transportError = describeError(error);
          attachRequestDiagnostic(error, { ...responseDiagnostic, stage: "body", statusCode: response.status, elapsedMs: Date.now() - responseStarted, causeCodes: safeCauseCodes(error), retryable: false, willRetry: false });
          controller.error(error);
        }
      },
      cancel(reason) { return reader.cancel(reason); }
    }, { highWaterMark: 0 });
    const wrappedResponse = new Response(body, {
      status: response.status, statusText: response.statusText, headers: response.headers
    });
    attachRequestDiagnostic(wrappedResponse, responseDiagnostic);
    return wrappedResponse;
  } catch (error) {
    exchange.transportError = describeError(error);
    throw error;
  }
}

/** One scope per provider attempt: fallbacks cannot replace the last failure with a success. */
export async function withProviderExchangeDump<T>(
  context: Pick<LlmProviderRequestContext, "config" | "modelRef" | "model"> & Partial<Pick<LlmProviderRequestContext, "logger">>,
  skipDebugDump: boolean | undefined,
  run: () => Promise<T>,
  kind: "chat" | "image" | "audio" | "decision" | "transcription" = "chat"
): Promise<T> {
  const requestId = randomUUID();
  const started = Date.now();
  return activeDiagnosticLogger.run({ ...(context.logger ? { logger: context.logger } : {}), allowRetry: kind === "chat" }, async () => {
    try { return await runProviderExchangeDump(context, skipDebugDump, run, kind); }
    catch (error) {
      if (!getRequestDiagnostic(error)) {
        const statusCode = error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : undefined;
        attachRequestDiagnostic(error, { requestId, stage: "provider", attempt: 1, ...(activeDiagnosticLogger.getStore()?.latest ?? {}), elapsedMs: Date.now() - (activeDiagnosticLogger.getStore()?.started ?? started), causeCodes: safeCauseCodes(error), retryable: false, willRetry: false, ...(statusCode ? { statusCode, stage: "response" as const } : {}) });
      }
      context.logger?.warn({ modelRef: context.modelRef, model: context.model, requestDiagnostic: getRequestDiagnostic(error) }, "llm_request_failed");
      throw error;
    }
  });
}

async function runProviderExchangeDump<T>(
  context: Pick<LlmProviderRequestContext, "config" | "modelRef" | "model"> & Partial<Pick<LlmProviderRequestContext, "logger">>,
  skipDebugDump: boolean | undefined, run: () => Promise<T>,
  kind: "chat" | "image" | "audio" | "decision" | "transcription"
): Promise<T> {
  if (skipDebugDump) return run();
  const exchanges: Exchange[] = [];
  const id = randomUUID();
  const startedAt = new Date().toISOString();
  let result: T | undefined;
  let failure: ReturnType<typeof describeError> | undefined;
  return activeExchanges.run(exchanges, async () => {
    try {
      result = await run();
      return result;
    } catch (error) {
      failure = describeError(error);
      throw error;
    } finally {
      if (failure || context.config.llm.debugDump.enabled) {
        try {
          const parsed = kind === "chat" && result !== undefined ? JSON.stringify(result) : undefined;
          const parsedTruncated = parsed !== undefined && Buffer.byteLength(parsed) > BODY_LIMIT;
          const payload = {
            id, startedAt, dumpedAt: new Date().toISOString(),
            modelRef: context.modelRef, model: context.model,
            outcome: failure ? "error" : "success", error: failure ?? null,
            bodyLimitBytes: BODY_LIMIT,
            parsedResponse: parsed && !parsedTruncated ? JSON.parse(parsed) : null,
            parsedResponseOmitted: parsedTruncated,
            exchanges: exchanges.map(({ body, ...exchange }) => ({
              ...exchange,
              rawBody: Buffer.concat(body).toString("utf8"),
              bodyTruncated: exchange.receivedBytes > exchange.capturedBytes
            }))
          };
          const dataDir = context.config.dataDir === "data"
            ? join("data", context.config.configRuntime.instanceName) : context.config.dataDir;
          const directory = resolve(dataDir, "dump");
          await mkdir(directory, { recursive: true });
          const prefix = kind === "chat" ? "" : `${kind}-`;
          const serialized = JSON.stringify(payload, null, 2) + "\n";
          for (const name of [`last-${prefix}exchange.json`, ...(failure ? [`last-failed-${prefix}exchange.json`] : [])]) {
            const target = join(directory, name);
            const temporary = `${target}.${id}.tmp`;
            try {
              await writeFile(temporary, serialized, { mode: 0o600 });
              await rename(temporary, target);
            } finally {
              await rm(temporary, { force: true });
            }
          }
        } catch (error) {
          context.logger?.warn({ err: error }, "Failed to write provider exchange dump");
        }
      }
    }
  });
}
