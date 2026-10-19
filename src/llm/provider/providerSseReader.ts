import type { fetchProviderResponse } from "./providerExchangeDump.ts";
import { extractSseDataLines, splitSseEvents } from "./providerStreamAdapter.ts";

export function throwIfProviderError(payload: unknown): void {
  if (!payload || typeof payload !== "object") return;
  const record = payload as Record<string, unknown>;
  const error = record.error ?? (record.code && record.message ? record : null);
  if (error == null) return;
  const details = typeof error === "object" ? error as Record<string, unknown> : {};
  const code = details.code ?? details.type;
  const message = typeof error === "string" ? error : String(details.message ?? JSON.stringify(error));
  throw new Error(`LLM API error: ${code == null ? "" : `${String(code)} `}${message}`);
}

function* eventData(event: string): Generator<string> {
  const data = extractSseDataLines(event);
  if (data.length === 0 && /^[\s]*[\[{]/.test(event)) {
    const payload: unknown = JSON.parse(event);
    throwIfProviderError(payload);
    throw new Error("LLM API returned JSON instead of an SSE stream");
  }
  if (data.length === 0 && event.split("\n").some(line => line.trim() && !/^(?:[:]|event:|id:|retry:|data:)/.test(line))) {
    throw new Error("LLM API returned a non-SSE response; inspect the raw exchange dump");
  }
  yield* data;
}

/** Shared framing for every streaming provider; includes decoder flush and an unterminated final event. */
export async function* readProviderSseData(
  response: Awaited<ReturnType<typeof fetchProviderResponse>>
): AsyncGenerator<string> {
  if (!response.body) throw new Error("LLM stream body is missing");
  if (response.headers.get("content-type")?.includes("application/json")) {
    const payload: unknown = JSON.parse(await response.text());
    throwIfProviderError(payload);
    throw new Error("LLM API returned JSON instead of an SSE stream");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const parsed = splitSseEvents(buffer);
      buffer = parsed.remainder;
      if (done) completed = true;
      for (const event of parsed.events) yield* eventData(event);
      if (done) {
        if (buffer.trim()) yield* eventData(buffer);
        break;
      }
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
