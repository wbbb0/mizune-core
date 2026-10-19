import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Response } from "undici";
import { fetchWithProxy } from "#services/proxy/index.ts";
import type { LlmProviderRequestContext } from "./providerTypes.ts";

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

function describeError(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
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
  if (!exchanges) return fetchWithProxy(...args);
  const exchange: Exchange = {
    endpoint: diagnosticEndpoint(args[2]),
    requestBody: typeof args[3]?.body === "string" ? args[3].body : null,
    body: [], capturedBytes: 0, receivedBytes: 0, bodyComplete: false
  };
  exchanges.push(exchange);
  try {
    const response = await fetchWithProxy(...args);
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
          if (retained.byteLength) {
            exchange.body.push(Buffer.from(retained));
            exchange.capturedBytes += retained.byteLength;
          }
          controller.enqueue(value);
        } catch (error) {
          exchange.transportError = describeError(error);
          controller.error(error);
        }
      },
      cancel(reason) { return reader.cancel(reason); }
    }, { highWaterMark: 0 });
    return new Response(body, {
      status: response.status, statusText: response.statusText, headers: response.headers
    });
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
  kind: "chat" | "image" = "chat"
): Promise<T> {
  if (skipDebugDump) return run();
  const exchanges: Exchange[] = [];
  const id = randomUUID();
  const startedAt = new Date().toISOString();
  let failure: { name: string; message: string } | undefined;
  return activeExchanges.run(exchanges, async () => {
    try {
      return await run();
    } catch (error) {
      failure = describeError(error);
      throw error;
    } finally {
      if (failure || context.config.llm.debugDump.enabled) {
        try {
          const payload = {
            id, startedAt, dumpedAt: new Date().toISOString(),
            modelRef: context.modelRef, model: context.model,
            outcome: failure ? "error" : "success", error: failure ?? null,
            bodyLimitBytes: BODY_LIMIT,
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
          const prefix = kind === "image" ? "image-" : "";
          for (const name of [`last-${prefix}exchange.json`, ...(failure ? [`last-failed-${prefix}exchange.json`] : [])]) {
            const target = join(directory, name);
            const temporary = `${target}.${id}.tmp`;
            await writeFile(temporary, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
            await rename(temporary, target);
          }
        } catch (error) {
          context.logger?.warn({ err: error }, "Failed to write provider exchange dump");
        }
      }
    }
  });
}
